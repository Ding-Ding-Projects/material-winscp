// guitools.test.js — GUITools.cpp, source/components/ and core/FileSystems.cpp.
//
// The rows here are behaviours found in the C++, including the awkward ones:
// a bare '%' surviving file-name encoding, '.bashrc' being all extension,
// descending sort NOT reversing the '..'-first grouping, an unmatched quote
// refusing the command outright, and the deterministic temporary directory
// having no root to clean up.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const G = require('../design/main/guitools');
const M = require('../design/main/masks');
const FS = require('../design/main/filesystems');

test('display metrics use safe logical fallbacks', () => {
  assert.deepStrictEqual(G.normalizeDisplayMetrics({ workArea: { width: 0, height: NaN } }), { scaleFactor: 1, workArea: { x: 0, y: 0, width: 1, height: 720 } });
});

test('restored window bounds remain usable and reachable', () => {
  assert.deepStrictEqual(G.constrainWindowBounds({ x: -5000, y: 4000, width: 120, height: 100 }, { workArea: { x: 100, y: 50, width: 1200, height: 800 } }), { x: -652, y: 802, width: 800, height: 520 });
  assert.deepStrictEqual(G.constrainWindowBounds({}, { workArea: { x: 0, y: 0, width: 600, height: 400 } }, { minWidth: 900, minHeight: 700 }), { x: 0, y: 0, width: 600, height: 400 });
});

// ---------------------------------------------------------------------------
// Command splitting, quoting, formatting
// ---------------------------------------------------------------------------

test('splitCommand: quoted program, unquoted program, directory part', () => {
  assert.deepStrictEqual(
    G.splitCommand('"C:\\Program Files\\np.exe" -a "b c"'),
    { program: 'C:\\Program Files\\np.exe', params: '-a "b c"', dir: 'C:\\Program Files\\' });

  assert.deepStrictEqual(
    G.splitCommand('notepad.exe  file.txt'),
    { program: 'notepad.exe', params: 'file.txt', dir: '' });

  assert.deepStrictEqual(
    G.splitCommand('   notepad   '),
    { program: 'notepad', params: '', dir: '' });

  assert.deepStrictEqual(
    G.splitCommand('/usr/bin/vi a').dir, '/usr/bin/');
});

test('splitCommand refuses an unterminated quote instead of guessing', () => {
  assert.throws(() => G.splitCommand('"C:\\np.exe -a'), G.ShellCommandError);
});

test('formatCommand quotes only what needs it, and trims', () => {
  assert.strictEqual(G.formatCommand('  notepad  ', '  a  '), 'notepad a');
  assert.strictEqual(G.formatCommand('C:\\Program Files\\np.exe', ''), '"C:\\Program Files\\np.exe"');
  assert.strictEqual(G.formatCommand('np.exe', ''), 'np.exe');
});

test('addPathQuotes strips existing quotes before adding its own', () => {
  assert.strictEqual(G.addPathQuotes('"C:\\a b\\c"'), '"C:\\a b\\c"');
  assert.strictEqual(G.addPathQuotes('C:\\ab\\c'), 'C:\\ab\\c');
});

test('extractProgramName drops path and extension', () => {
  assert.strictEqual(G.extractProgramName('"C:\\Program Files\\np.exe" x'), 'np');
  assert.strictEqual(G.extractProgramName('vim'), 'vim');
});

test('reformatFileNameCommand appends the file pattern only when missing', () => {
  assert.strictEqual(G.reformatFileNameCommand('notepad'), 'notepad !.!');
  assert.strictEqual(G.reformatFileNameCommand('notepad !.!'), 'notepad !.!');
  assert.strictEqual(G.reformatFileNameCommand('"C:\\a b\\np.exe" -x'), '"C:\\a b\\np.exe" -x !.!');
  assert.strictEqual(G.reformatFileNameCommand(''), '');
});

test('expandFileNameCommand quotes the substituted name when it has spaces', () => {
  assert.strictEqual(G.expandFileNameCommand('np !.!', 'C:\\a b\\c.txt'), 'np "C:\\a b\\c.txt"');
  assert.strictEqual(G.expandFileNameCommand('np !.! !.!', 'C:\\c.txt'), 'np C:\\c.txt C:\\c.txt');
});

test('escapeParam doubles quotes', () => {
  assert.strictEqual(G.escapeParam('say "hi"'), 'say ""hi""');
});

test('escapePuttyCommandParam: backslashes only double in front of a quote', () => {
  assert.strictEqual(G.escapePuttyCommandParam('plain'), 'plain');
  assert.strictEqual(G.escapePuttyCommandParam('has space'), '"has space"');
  assert.strictEqual(G.escapePuttyCommandParam('a"b'), 'a\\"b');
  // A backslash NOT before a quote stays single.
  assert.strictEqual(G.escapePuttyCommandParam('C:\\dir\\file'), 'C:\\dir\\file');
  // A backslash before a quote is doubled and the quote escaped.
  assert.strictEqual(G.escapePuttyCommandParam('a\\"b'), 'a\\\\\\"b');
});

test('Windows argument quoting round-trips through the CommandLineToArgvW rules', () => {
  const cases = [
    ['plain'],
    ['has space', 'a"b'],
    ['C:\\dir\\', 'x'],
    ['ends\\with\\backslash\\'],
    ['", quote first'],
    [''],
  ];
  for (const args of cases) {
    const line = G.buildWindowsCommandLine('prog.exe', args);
    const parsed = G.parseWindowsCommandLine(line);
    assert.deepStrictEqual(parsed, ['prog.exe', ...args], line);
  }
});

test('quoteWindowsArg leaves a clean argument alone but quotes an empty one', () => {
  assert.strictEqual(G.quoteWindowsArg('abc'), 'abc');
  assert.strictEqual(G.quoteWindowsArg(''), '""');
  assert.strictEqual(G.quoteWindowsArg('a b'), '"a b"');
});

// ---------------------------------------------------------------------------
// Environment expansion
// ---------------------------------------------------------------------------

test('expandEnvironmentVariables leaves an unknown variable verbatim', () => {
  const env = { EDITOR: 'C:\\ed', ProgramFiles: 'C:\\PF' };
  assert.strictEqual(G.expandEnvironmentVariables('%EDITOR%\\x.exe', env), 'C:\\ed\\x.exe');
  // Blanking an unknown variable would turn this into a path to the root.
  assert.strictEqual(G.expandEnvironmentVariables('%NOPE%\\x.exe', env), '%NOPE%\\x.exe');
  // Windows lookup is case-insensitive.
  assert.strictEqual(G.expandEnvironmentVariables('%programfiles%', env), 'C:\\PF');
  assert.strictEqual(G.expandEnvironmentVariables('100%% sure', env), '100%% sure');
});

// ---------------------------------------------------------------------------
// File-name validation
// ---------------------------------------------------------------------------

test('makeValidFileName replaces every illegal character with a dash', () => {
  assert.strictEqual(G.makeValidFileName('user@host:22/path'), 'user@host-22-path');
  assert.strictEqual(G.makeValidFileName('a b'), 'a-b');
});

test('validLocalFileName token mode encodes so that decoding is unambiguous', () => {
  assert.strictEqual(G.validLocalFileName('a:b*c'), 'a%3Ab%2Ac');
  assert.strictEqual(G.validLocalFileName('a/b\\c'), 'a%2Fb%5Cc');
  // A remote file LITERALLY named 'a%3Ab' must not come back as 'a:b', so the
  // '%' is itself encoded. Encoding is deliberately not idempotent — that is
  // what makes the mapping reversible.
  assert.strictEqual(G.validLocalFileName('a%3Ab'), 'a%253Ab');
  // A '%' that could not be an encoding is harmless and is left alone.
  assert.strictEqual(G.validLocalFileName('100% sure'), '100% sure');
  assert.strictEqual(G.validLocalFileName('50%'), '50%');
  assert.strictEqual(G.validLocalFileName('a%zzb'), 'a%zzb');
});

test('validLocalFileName protects trailing space and dot, which Windows eats', () => {
  assert.strictEqual(G.validLocalFileName('name '), 'name%20');
  assert.strictEqual(G.validLocalFileName('name.'), 'name%2E');
  assert.strictEqual(G.validLocalFileName('name'), 'name');
});

test('validLocalFileName escapes reserved device names', () => {
  assert.strictEqual(G.validLocalFileName('con'), 'con%00');
  assert.strictEqual(G.validLocalFileName('CON.txt'), 'CON%00.txt');
  assert.strictEqual(G.validLocalFileName('com1.log'), 'com1%00.log');
  assert.strictEqual(G.validLocalFileName('console'), 'console');
  assert.strictEqual(G.validLocalFileName('com0'), 'com0');
});

test('validLocalFileName with a plain replacement character', () => {
  assert.strictEqual(G.validLocalFileName('a:b', { replacement: '_' }), 'a_b');
  assert.strictEqual(G.validLocalFileName('100%', { replacement: '_' }), '100%');
});

test('validLocalFileName with no replacement refuses a path separator', () => {
  assert.strictEqual(G.validLocalFileName('a:b', { replacement: null }), 'a:b');
  assert.throws(() => G.validLocalFileName('a/b', { replacement: null }), G.InvalidFileNameError);
});

test('validLocalPath validates each segment and keeps the separators', () => {
  assert.strictEqual(G.validLocalPath('a:b\\c*d'), 'a%3Ab\\c%2Ad');
  assert.strictEqual(G.validLocalPath(''), '');
});

// ---------------------------------------------------------------------------
// findFile / findTool
// ---------------------------------------------------------------------------

test('findFile returns the path unchanged when it already exists', () => {
  const r = G.findFile('C:\\a\\b.exe', { exists: (p) => p === 'C:\\a\\b.exe', env: {} });
  assert.deepStrictEqual(r, { found: true, path: 'C:\\a\\b.exe' });
});

test('findFile follows the 32-bit to 64-bit Program Files redirection', () => {
  const env = { ProgramFiles: 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files' };
  const exists = (p) => p === 'C:\\Program Files\\Tool\\t.exe';
  const r = G.findFile('C:\\Program Files (x86)\\Tool\\t.exe', { env, exists });
  assert.deepStrictEqual(r, { found: true, path: 'C:\\Program Files\\Tool\\t.exe' });
});

test('findFile searches PATH only for a bare name', () => {
  const env = { PATH: 'C:\\bin;C:\\other' };
  const exists = (p) => p === 'C:\\other\\t.exe';
  assert.deepStrictEqual(G.findFile('t.exe', { env, exists }), { found: true, path: 'C:\\other\\t.exe' });
  // A name with a directory component is never looked up along PATH.
  assert.deepStrictEqual(
    G.findFile('sub\\t.exe', { env, exists }),
    { found: false, path: 'sub\\t.exe' });
});

test('findFile reports not-found without throwing', () => {
  assert.deepStrictEqual(
    G.findFile('nowhere.exe', { env: {}, exists: () => false }),
    { found: false, path: 'nowhere.exe' });
});

test('findTool prefers the app directory, then the bundle folder, then PATH', () => {
  const opts = (existing) => ({
    appDir: 'C:\\App', env: { PATH: 'C:\\bin' }, exists: (p) => p === existing,
  });
  assert.deepStrictEqual(G.findTool('t.exe', opts('C:\\App\\t.exe')), { found: true, path: 'C:\\App\\t.exe' });
  assert.deepStrictEqual(G.findTool('t.exe', opts('C:\\App\\PuTTY\\t.exe')), { found: true, path: 'C:\\App\\PuTTY\\t.exe' });
  assert.deepStrictEqual(G.findTool('t.exe', opts('C:\\bin\\t.exe')), { found: true, path: 'C:\\bin\\t.exe' });
  assert.strictEqual(G.findTool('t.exe', opts('nope')).found, false);
});

// ---------------------------------------------------------------------------
// External application resolution
// ---------------------------------------------------------------------------

test('resolveExternalApplication expands env in the program but not the params', () => {
  const env = { ED: 'C:\\ed' };
  const r = G.resolveExternalApplication('%ED%\\np.exe -x', 'C:\\docs\\100% sure.txt', {
    env, exists: (p) => p === 'C:\\ed\\np.exe',
  });
  assert.strictEqual(r.program, 'C:\\ed\\np.exe');
  // The '%' in the file name must survive: it is data, not a variable.
  assert.strictEqual(r.params, '-x "C:\\docs\\100% sure.txt"');
  assert.strictEqual(r.found, true);
});

test('resolveExternalApplication appends the file when the command forgot to', () => {
  const r = G.resolveExternalApplication('notepad', 'C:\\a.txt', { env: {}, exists: () => true });
  assert.strictEqual(r.params, 'C:\\a.txt');
  assert.strictEqual(r.commandLine, 'notepad C:\\a.txt');
});

test('resolveExternalApplication reports a missing program rather than throwing', () => {
  const r = G.resolveExternalApplication('missing.exe', 'C:\\a.txt', { env: {}, exists: () => false });
  assert.strictEqual(r.found, false);
});

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

test('buildSpawn keeps the user command line verbatim on Windows', () => {
  const plan = G.buildSpawn('C:\\a b\\np.exe', '-x "C:\\f.txt"', {
    platform: 'win32', changeWorkingDirectory: true,
  });
  assert.strictEqual(plan.options.windowsVerbatimArguments, true);
  assert.deepStrictEqual(plan.args, ['-x "C:\\f.txt"']);
  assert.strictEqual(plan.options.cwd, 'C:\\a b\\');
  assert.strictEqual(plan.commandLine, '"C:\\a b\\np.exe" -x "C:\\f.txt"');
});

test('buildSpawn quotes argv[0] so a spacey program path is not split', () => {
  // With windowsVerbatimArguments Node writes `file` into the command line
  // itself; unquoted, a tool under "C:\Program Files\..." reads its own path as
  // two arguments. The whole verbatim line must equal FormatCommand's output.
  const plan = G.buildSpawn('C:\\Program Files\\ed\\np.exe', '-x', { platform: 'win32' });
  assert.strictEqual(plan.options.argv0, '"C:\\Program Files\\ed\\np.exe"');
  assert.strictEqual(
    [plan.options.argv0, ...plan.args].join(' '),
    plan.commandLine,
    'the verbatim command line must be exactly FormatCommand(program, params)');

  // A path with no space needs no quotes, exactly as AddQuotes decides.
  const plain = G.buildSpawn('C:\\ed\\np.exe', '-x', { platform: 'win32' });
  assert.strictEqual(plain.options.argv0, 'C:\\ed\\np.exe');
  assert.strictEqual([plain.options.argv0, ...plain.args].join(' '), plain.commandLine);
});

test('buildSpawn does not set argv0 off Windows, where argv is a real vector', () => {
  const plan = G.buildSpawn('/usr/bin/vi', '-x "a b"', { platform: 'linux' });
  assert.strictEqual(plan.options.argv0, undefined);
});

test('buildSpawn splits the parameter string into argv off Windows', () => {
  const plan = G.buildSpawn('/usr/bin/vi', '-x "a b"', { platform: 'linux' });
  assert.deepStrictEqual(plan.args, ['-x', 'a b']);
  assert.strictEqual(plan.options.windowsVerbatimArguments, undefined);
});

test('holding Ctrl copies the command instead of running it', () => {
  const copied = [];
  const result = G.executeShell('np.exe', '-x', {
    platform: 'win32',
    alternativeFunction: true,
    ctrlPressed: true,
    copyToClipboard: (c) => copied.push(c),
    spawn: () => { throw new Error('must not spawn'); },
  });
  assert.strictEqual(result.copied, true);
  assert.deepStrictEqual(copied, ['np.exe -x']);
  assert.strictEqual(result.child, null);

  assert.strictEqual(G.shouldCopyCommandInsteadOfExecuting({ alternativeFunction: true, ctrlPressed: false }), false);
  assert.strictEqual(G.shouldCopyCommandInsteadOfExecuting({ alternativeFunction: true, ctrlPressed: true, disabled: true }), false);
});

test('executeShell spawns with the computed plan', () => {
  let seen = null;
  const result = G.executeShell('np.exe', '-x', {
    platform: 'win32',
    spawn: (file, args, options) => { seen = { file, args, options }; return { pid: 42 }; },
  });
  assert.strictEqual(result.copied, false);
  assert.strictEqual(seen.file, 'np.exe');
  assert.deepStrictEqual(seen.args, ['-x']);
  assert.strictEqual(result.child.pid, 42);
});

test('executeShellChecked names the program in its error', () => {
  assert.throws(
    () => G.executeShellChecked('gone.exe', '', { exists: () => false }),
    (e) => e instanceof G.ExecuteAppError && e.message.includes('gone.exe'));
});

// ---------------------------------------------------------------------------
// Temporary directories
// ---------------------------------------------------------------------------

test('uniqTempDir mask has exactly the five digits the real name produces', () => {
  const mask = G.uniqTempDir('C:\\Temp', 'scp', true);
  assert.strictEqual(mask, 'C:\\Temp\\scp?????');

  const real = G.uniqTempDir('C:\\Temp', 'scp', false, {
    now: () => new Date(2020, 0, 1, 10, 7, 0, 42),
    directoryExists: () => false,
  });
  assert.strictEqual(real, 'C:\\Temp\\scp07042\\');
  // The name minus the trailing separator must be matched by the mask.
  const stem = real.slice(0, -1);
  assert.strictEqual(stem.length, mask.length);
});

test('uniqTempDir retries until the name is free', () => {
  let ms = 100;
  const dir = G.uniqTempDir('C:\\Temp', 'scp', false, {
    now: () => new Date(2020, 0, 1, 10, 0, 0, ms++),
    directoryExists: (p) => p === 'C:\\Temp\\scp00100\\',
  });
  assert.strictEqual(dir, 'C:\\Temp\\scp00101\\');
});

test('uniqTempDir gives up rather than looping forever', () => {
  assert.throws(() => G.uniqTempDir('C:\\Temp', 'scp', false, {
    now: () => new Date(2020, 0, 1, 10, 0, 0, 5),
    directoryExists: () => true,
    maxAttempts: 3,
  }), G.CreateTempDirError);
});

test('expandedTemporaryDirectory falls back to the system temp folder', () => {
  assert.strictEqual(
    G.expandedTemporaryDirectory({ ddTemporaryDirectory: '' }, { systemTemp: 'C:\\Sys\\Temp\\' }),
    'C:\\Sys\\Temp\\');
  assert.strictEqual(
    G.expandedTemporaryDirectory({ ddTemporaryDirectory: '%T%\\x' }, { env: { T: path.resolve('C:\\t') } }),
    path.resolve('C:\\t\\x'));
});

test('temporaryDirectoryForRemoteFiles: the ordinary case gets a unique root', () => {
  const made = [];
  const r = G.temporaryDirectoryForRemoteFiles('/var/www', {
    ddTemporaryDirectory: 'C:\\Tmp',
    temporaryDirectoryAppendSession: true,
    temporaryDirectoryAppendPath: true,
  }, {
    sessionName: 'user@host',
    now: () => new Date(2020, 0, 1, 10, 7, 0, 42),
    directoryExists: () => false,
    mkdir: (p) => made.push(p),
    systemTemp: 'C:\\Sys\\',
  });
  assert.strictEqual(r.rootDir, path.resolve('C:\\Tmp') + '\\scp07042\\');
  assert.strictEqual(r.dir, r.rootDir + 'user@host\\var\\www\\');
  assert.deepStrictEqual(made, [r.dir]);
});

test('temporaryDirectoryForRemoteFiles: deterministic mode has no root to clean up', () => {
  const r = G.temporaryDirectoryForRemoteFiles('/var/www', {
    ddTemporaryDirectory: 'C:\\Tmp',
    temporaryDirectoryDeterministic: true,
    temporaryDirectoryAppendPath: true,
  }, { mkdir: () => {} });
  // rootDir is deliberately empty: there is no throwaway directory, so a caller
  // that deleted rootDir would delete the user's configured temp folder.
  assert.strictEqual(r.rootDir, '');
  assert.strictEqual(r.dir, path.resolve('C:\\Tmp') + '\\var\\www\\');

  // Deterministic means stable: the same remote path gives the same local path.
  const again = G.temporaryDirectoryForRemoteFiles('/var/www', {
    ddTemporaryDirectory: 'C:\\Tmp',
    temporaryDirectoryDeterministic: true,
    temporaryDirectoryAppendPath: true,
  }, { mkdir: () => {} });
  assert.strictEqual(again.dir, r.dir);
});

test('temporaryDirectoryForRemoteFiles: "simple" ignores deterministic and the suffixes', () => {
  const r = G.temporaryDirectoryForRemoteFiles('/var/www', {
    ddTemporaryDirectory: 'C:\\Tmp',
    temporaryDirectoryDeterministic: true,
    temporaryDirectoryAppendSession: true,
    temporaryDirectoryAppendPath: true,
  }, {
    simple: true,
    sessionName: 'user@host',
    now: () => new Date(2020, 0, 1, 10, 7, 0, 42),
    directoryExists: () => false,
    mkdir: () => {},
  });
  assert.strictEqual(r.dir, path.resolve('C:\\Tmp') + '\\scp07042\\');
  assert.strictEqual(r.dir, r.rootDir);
});

test('temporaryDirectoryForRemoteFiles: an invalid remote name is encoded, not passed through', () => {
  const r = G.temporaryDirectoryForRemoteFiles('/a:b/c*d', {
    ddTemporaryDirectory: 'C:\\Tmp',
    temporaryDirectoryDeterministic: true,
    temporaryDirectoryAppendPath: true,
  }, { mkdir: () => {} });
  assert.strictEqual(r.dir, path.resolve('C:\\Tmp') + '\\a%3Ab\\c%2Ad\\');
});

test('temporaryDirectoryForRemoteFiles reports a creation failure as its own error', () => {
  assert.throws(() => G.temporaryDirectoryForRemoteFiles('/x', {
    ddTemporaryDirectory: 'C:\\Tmp',
    temporaryDirectoryDeterministic: true,
  }, { mkdir: () => { throw new Error('EACCES'); } }), G.CreateTempDirError);
});

// ---------------------------------------------------------------------------
// ApplyTabs
// ---------------------------------------------------------------------------

test('applyTabs aligns the second column across lines', () => {
  const text = 'a\tone\nlonger\ttwo';
  const out = G.applyTabs(text, ' ');
  const lines = out.split('\n');
  assert.strictEqual(lines[0], 'a       one');
  assert.strictEqual(lines[1], 'longer  two');
});

test('applyTabs leaves text without tabs untouched', () => {
  assert.strictEqual(G.applyTabs('no tabs here', ' '), 'no tabs here');
});

test('applyTabs tolerates the old consecutive-tab padding hack', () => {
  const e = G.isEligibleForApplyingTabs('a\t\t\tvalue');
  assert.strictEqual(e.remaining, 'value');
  assert.strictEqual(e.start, 'a  ');
  // More than one *content-separating* tab is not supported and is skipped.
  assert.strictEqual(G.isEligibleForApplyingTabs('a\tb\tc'), null);
  assert.strictEqual(G.isEligibleForApplyingTabs('no tab'), null);
});

// ---------------------------------------------------------------------------
// Comparison primitives
// ---------------------------------------------------------------------------

test('strCmpLogical compares digit runs by value', () => {
  assert.ok(G.strCmpLogical('a2', 'a10') < 0);
  assert.ok(G.strCmpLogical('a10', 'a2') > 0);
  assert.strictEqual(G.strCmpLogical('a2', 'a2'), 0);
  assert.ok(G.strCmpLogical('img9x', 'img10x') < 0);
  // Same value, different leading zeros: more zeros first.
  assert.ok(G.strCmpLogical('file01', 'file1') < 0);
});

test('compareLogicalText breaks a case-insensitive tie with an ordinal compare', () => {
  assert.strictEqual(G.compareLogicalText('abc', 'abc', false), 0);
  assert.notStrictEqual(G.compareLogicalText('ABC', 'abc', false), 0);
  assert.ok(G.compareLogicalText('a', 'B', false) < 0);   // case-insensitive first
});

test('containsTextSemiCaseSensitive: a capital makes the search case-sensitive', () => {
  assert.strictEqual(G.containsTextSemiCaseSensitive('README', 'rea'), true);
  assert.strictEqual(G.containsTextSemiCaseSensitive('README', 'Rea'), false);
  assert.strictEqual(G.containsTextSemiCaseSensitive('Readme', 'Rea'), true);
  assert.strictEqual(G.containsTextSemiCaseSensitive('anything', ''), true);
});

test('unixExtractFileExt returns the whole name for a dot-file', () => {
  assert.strictEqual(G.unixExtractFileExt('a.txt'), '.txt');
  assert.strictEqual(G.unixExtractFileExt('archive.tar.gz'), '.gz');
  assert.strictEqual(G.unixExtractFileExt('README'), '');
  // WinSCP's own behaviour: the last dot is at position 1, so the extension is
  // the entire name. Sorting by Ext therefore groups dot-files by themselves.
  assert.strictEqual(G.unixExtractFileExt('.bashrc'), '.bashrc');
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

test('column definitions match the original design-time defaults', () => {
  const remote = G.defaultColumns('remote');
  assert.deepStrictEqual(remote.map((c) => c.id),
    ['name', 'size', 'changed', 'rights', 'owner', 'group', 'ext', 'linkTarget', 'type']);
  assert.strictEqual(remote[1].alignment, 'right');           // size is right-aligned
  assert.deepStrictEqual(remote.filter((c) => !c.visible).map((c) => c.id),
    ['ext', 'linkTarget', 'type']);

  const local = G.defaultColumns('local');
  assert.deepStrictEqual(local.map((c) => c.id), ['name', 'size', 'type', 'changed', 'attr', 'ext']);
  assert.deepStrictEqual(local.filter((c) => !c.visible).map((c) => c.id), ['ext']);

  // defaultColumns must hand out copies; editing one panel cannot change another.
  remote[0].width = 1;
  assert.notStrictEqual(G.defaultColumns('remote')[0].width, 1);
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function f(name, extra) {
  return { name, type: 'file', size: 0, mtime: 0, ...(extra || {}) };
}
function d(name, extra) {
  return { name, type: 'dir', size: 0, mtime: 0, ...(extra || {}) };
}

test('remote sort groups parent, directories, then files', () => {
  const items = [f('b.txt'), d('zdir'), f('a.txt'), { name: '..', type: 'dir' }, d('adir')];
  const sorted = G.sortItems(items, { sortColumn: 'name' });
  assert.deepStrictEqual(sorted.map((i) => i.name), ['..', 'adir', 'zdir', 'a.txt', 'b.txt']);
});

test('descending sort reverses within a group but never the grouping itself', () => {
  const items = [f('b.txt'), d('zdir'), f('a.txt'), { name: '..', type: 'dir' }, d('adir')];
  const sorted = G.sortItems(items, { sortColumn: 'name', ascending: false });
  assert.deepStrictEqual(sorted.map((i) => i.name), ['..', 'zdir', 'adir', 'b.txt', 'a.txt']);
});

test('alwaysSortDirectoriesByName keeps directories in name order under any column', () => {
  const items = [d('zdir', { size: 1 }), d('adir', { size: 99 }), f('f1', { size: 5 }), f('f2', { size: 1 })];
  const byName = G.sortItems(items, { sortColumn: 'size', alwaysSortDirectoriesByName: true });
  assert.deepStrictEqual(byName.map((i) => i.name), ['adir', 'zdir', 'f2', 'f1']);
  const bySize = G.sortItems(items, { sortColumn: 'size', alwaysSortDirectoriesByName: false });
  assert.deepStrictEqual(bySize.map((i) => i.name), ['zdir', 'adir', 'f2', 'f1']);
});

test('remote size sort prefers a calculated directory size when one exists', () => {
  const items = [d('big', { size: 0, calculatedSize: 900 }), d('small', { size: 0, calculatedSize: 10 })];
  const sorted = G.sortItems(items, { sortColumn: 'size' });
  assert.deepStrictEqual(sorted.map((i) => i.name), ['small', 'big']);
  assert.strictEqual(G.remoteItemSize(G.fileFields(items[0])), 900);
});

test('local size ignores a directory\'s on-disk size and uses the calculated one', () => {
  // DirViewInt.pas stores Size = -1 for a directory; a stat() size of 4096 must
  // not outrank a real calculated size, and must not make two directories of
  // different content compare equal.
  assert.strictEqual(
    G.localItemSize(G.fileFields({ name: 'd', type: 'dir', size: 4096, calculatedSize: 900 })), 900);
  assert.strictEqual(
    G.localItemSize(G.fileFields({ name: 'd', type: 'dir', size: 4096 })), 0);
  // A file still reports its own size, calculated size or not.
  assert.strictEqual(
    G.localItemSize(G.fileFields({ name: 'f', size: 5, calculatedSize: 900 })), 5);

  const items = [
    { name: 'big', type: 'dir', size: 4096, calculatedSize: 900 },
    { name: 'small', type: 'dir', size: 4096, calculatedSize: 10 },
  ];
  assert.deepStrictEqual(
    G.sortItems(items, { side: 'local', sortColumn: 'size' }).map((i) => i.name),
    ['small', 'big']);
});

test('remote ext sort falls back to name for directories, and type falls back to ext', () => {
  const items = [f('b.aaa'), f('a.zzz'), d('dir2'), d('dir1')];
  const byExt = G.sortItems(items, { sortColumn: 'ext' });
  assert.deepStrictEqual(byExt.map((i) => i.name), ['dir1', 'dir2', 'b.aaa', 'a.zzz']);

  const typed = [
    f('b.zzz', { typeName: 'Text' }),
    f('a.aaa', { typeName: 'Text' }),
  ];
  const byType = G.sortItems(typed, { sortColumn: 'type' });
  assert.deepStrictEqual(byType.map((i) => i.name), ['a.aaa', 'b.zzz']);
});

test('remote sort falls back to the name whenever the column ties', () => {
  const items = [f('b', { mtime: 5 }), f('a', { mtime: 5 })];
  assert.deepStrictEqual(
    G.sortItems(items, { sortColumn: 'changed' }).map((i) => i.name), ['a', 'b']);
});

test('local sort has its own columns: type key, attributes, extension', () => {
  const items = [
    f('b.txt', { typeName: 'Text Document', attr: 32, extension: '.txt' }),
    f('a.exe', { typeName: 'Application', attr: 1, extension: '.exe' }),
    d('sub', { typeName: 'File folder' }),
  ];
  assert.deepStrictEqual(
    G.sortItems(items, { side: 'local', sortColumn: 'type' }).map((i) => i.name),
    ['sub', 'a.exe', 'b.txt']);
  assert.deepStrictEqual(
    G.sortItems(items, { side: 'local', sortColumn: 'attr' }).map((i) => i.name),
    ['sub', 'a.exe', 'b.txt']);
  assert.deepStrictEqual(
    G.sortItems(items, { side: 'local', sortColumn: 'ext' }).map((i) => i.name),
    ['sub', 'a.exe', 'b.txt']);
});

test('natural order can be switched off', () => {
  const items = [f('a10'), f('a2')];
  assert.deepStrictEqual(
    G.sortItems(items, { sortColumn: 'name', naturalOrderNumericalSorting: true }).map((i) => i.name),
    ['a2', 'a10']);
  assert.deepStrictEqual(
    G.sortItems(items, { sortColumn: 'name', naturalOrderNumericalSorting: false }).map((i) => i.name),
    ['a10', 'a2']);
});

// ---------------------------------------------------------------------------
// Loading and filtering
// ---------------------------------------------------------------------------

test('loadFiles counts hidden and filtered entries separately', () => {
  const files = [
    { name: '..', type: 'dir' },
    { name: '.hidden', type: 'file', size: 1 },
    { name: 'a.txt', type: 'file', size: 10 },
    { name: 'b.log', type: 'file', size: 20 },
    { name: 'locked', type: 'dir', inaccessible: true },
  ];
  const parsed = M.parse('*.txt');
  const r = G.loadFiles(files, {
    showHiddenFiles: false,
    showInaccesibleDirectories: false,
    mask: '*.txt',
    matchesMask: (raw, ff) => M.matches(ff.name, { isDir: ff.isDirectory, size: ff.size }, parsed),
  });
  assert.deepStrictEqual(r.items.map((i) => i.name), ['..', 'a.txt']);
  assert.strictEqual(r.hiddenCount, 2);          // .hidden and the locked directory
  assert.strictEqual(r.filteredCount, 1);        // b.log
  assert.strictEqual(r.hasParentDir, true);
  assert.strictEqual(r.filesSize, 10);
});

test('loadFiles never mask-filters the way out of a directory', () => {
  const parsed = M.parse('*.txt');
  const r = G.loadFiles([{ name: '..', type: 'dir' }, { name: 'x.bin', type: 'file' }], {
    mask: '*.txt',
    matchesMask: (raw, ff) => M.matches(ff.name, { isDir: ff.isDirectory }, parsed),
  });
  assert.deepStrictEqual(r.items.map((i) => i.name), ['..']);
  assert.strictEqual(r.filteredCount, 1);
});

test('itemMatchesFilter applies file masks to files and directory masks to directories', () => {
  const fileMask = M.parse('a*');
  const matchFile = (item, ff, isDir) => M.matches(ff.name, { isDir }, fileMask);
  assert.strictEqual(G.itemMatchesFilter(f('a.txt'), { masks: 'a*' }, matchFile), true);
  assert.strictEqual(G.itemMatchesFilter(f('z.txt'), { masks: 'a*' }, matchFile), false);
  // A file-only mask leaves every directory implicitly included — WinSCP's
  // FAllDirsAreImplicitlyIncluded — so "select a*" does not deselect folders.
  assert.strictEqual(G.itemMatchesFilter(d('zzz'), { masks: 'a*' }, matchFile), true);

  const dirMask = M.parse('a*/');
  const matchDir = (item, ff, isDir) => M.matches(ff.name, { isDir }, dirMask);
  assert.strictEqual(G.itemMatchesFilter(d('abc'), { masks: 'a*/' }, matchDir), true);
  assert.strictEqual(G.itemMatchesFilter(d('zzz'), { masks: 'a*/' }, matchDir), false);
  // The Directories flag re-tests a directory as though it were a file, which
  // is the second clause of TUnixDirView::ItemMatchesFilter.
  assert.strictEqual(G.itemMatchesFilter(d('zzz'), { masks: 'a*/', directories: true }, matchDir), true);

  // No masks at all means everything matches.
  assert.strictEqual(G.itemMatchesFilter(d('abc'), { masks: '' }, matchFile), true);
});

// ---------------------------------------------------------------------------
// Selection model
// ---------------------------------------------------------------------------

test('Norton-like: the focused file is marked even with nothing selected', () => {
  const s = new G.SelectionModel({ count: 5, focusedIndex: 2 });
  assert.strictEqual(s.selCount, 0);
  assert.strictEqual(s.markedCount, 1);
  assert.deepStrictEqual(s.markedIndexes(), [2]);

  s.nortonLike = G.NORTON_LIKE.OFF;
  assert.strictEqual(s.markedCount, 0);
  assert.deepStrictEqual(s.markedIndexes(), []);
});

test('an explicit selection wins over the focused file', () => {
  const s = new G.SelectionModel({ count: 5, focusedIndex: 2 });
  s.setSelected(4, true);
  s.setSelected(0, true);
  assert.strictEqual(s.markedCount, 2);
  assert.deepStrictEqual(s.markedIndexes(), [0, 4]);
  assert.strictEqual(s.markedIndex, 0);
});

test('selectAll all/none/invert, with an exclusion', () => {
  const s = new G.SelectionModel({ count: 4 });
  s.selectAll(G.SELECT_MODE.ALL);
  assert.strictEqual(s.selCount, 4);
  s.selectAll(G.SELECT_MODE.NONE, 1);
  assert.deepStrictEqual([...s.selected], [1]);
  s.selectAll(G.SELECT_MODE.INVERT);
  assert.deepStrictEqual([...s.selected].sort((a, b) => a - b), [0, 2, 3]);
});

test('the parent directory can never be selected, by any route', () => {
  // TCustomDirView::CanChangeSelection is a refusal: without it "Select all"
  // followed by Delete would ask the server to delete '..'.
  const s = new G.SelectionModel({ count: 4, parentDirectoryIndex: 0 });

  assert.strictEqual(s.setSelected(0, true), false);
  assert.strictEqual(s.isSelected(0), false);

  s.selectAll(G.SELECT_MODE.ALL);
  assert.deepStrictEqual([...s.selected].sort((a, b) => a - b), [1, 2, 3]);
  assert.strictEqual(s.markedIndexes().includes(0), false);

  s.selectAll(G.SELECT_MODE.NONE);
  s.selectAll(G.SELECT_MODE.INVERT);
  assert.deepStrictEqual([...s.selected].sort((a, b) => a - b), [1, 2, 3]);

  // Insert on '..' does nothing rather than selecting it.
  s.selectAll(G.SELECT_MODE.NONE);
  s.focusedIndex = 0;
  s.selectCurrentItem(false);
  assert.strictEqual(s.isSelected(0), false);

  // selectFiles cannot smuggle it in either.
  const items = [{ name: '..' }, { name: 'a' }, { name: 'b' }, { name: 'c' }];
  s.selectFiles(items, () => true, true);
  assert.strictEqual(s.isSelected(0), false);

  // While the panel is loading nothing may change selection at all.
  const loading = new G.SelectionModel({ count: 3, loading: true });
  assert.strictEqual(loading.setSelected(1, true), false);

  // Removing an item above '..' keeps the guard pointing at the right row.
  const shifted = new G.SelectionModel({ count: 3, parentDirectoryIndex: 2 });
  shifted.deleteItem(0);
  assert.strictEqual(shifted.parentDirectoryIndex, 1);
  assert.strictEqual(shifted.setSelected(1, true), false);
});

test('Insert toggles the focused item and steps down', () => {
  const s = new G.SelectionModel({ count: 3, focusedIndex: 0 });
  s.selectCurrentItem(true);
  assert.strictEqual(s.isSelected(0), true);
  assert.strictEqual(s.focusedIndex, 1);
  s.selectCurrentItem(true);
  assert.strictEqual(s.isSelected(1), true);
  assert.strictEqual(s.focusedIndex, 2);
  // At the bottom the focus stays put rather than wrapping.
  s.selectCurrentItem(true);
  assert.strictEqual(s.focusedIndex, 2);
});

test('closestUnselected searches down first, then up, then gives up', () => {
  const s = new G.SelectionModel({ count: 5, nortonLike: G.NORTON_LIKE.OFF });
  s.setSelected(1, true);
  s.setSelected(2, true);
  assert.strictEqual(s.closestUnselected(1), 3);

  const t = new G.SelectionModel({ count: 3, nortonLike: G.NORTON_LIKE.OFF });
  t.setSelected(1, true);
  t.setSelected(2, true);
  assert.strictEqual(t.closestUnselected(2), 0);

  const u = new G.SelectionModel({ count: 2, nortonLike: G.NORTON_LIKE.OFF });
  u.selectAll(G.SELECT_MODE.ALL);
  assert.strictEqual(u.closestUnselected(0), null);

  // An unselected item is left where it is.
  assert.strictEqual(s.closestUnselected(4), 4);
});

test('deleting an item shifts the selection down and keeps the endpoints honest', () => {
  const s = new G.SelectionModel({ count: 5, focusedIndex: 4 });
  s.setSelected(1, true);
  s.setSelected(3, true);
  s.deleteItem(0);
  assert.deepStrictEqual([...s.selected].sort((a, b) => a - b), [0, 2]);
  assert.strictEqual(s.count, 4);
  assert.strictEqual(s.focusedIndex, 3);
});

test('a reorder invalidates the cached first/last rather than lying about them', () => {
  const s = new G.SelectionModel({ count: 4 });
  s.setSelected(2, true);
  assert.strictEqual(s.firstSelected, 2);
  s.itemsReordered();
  assert.strictEqual(s.firstSelected, -1);
  assert.strictEqual(s.lastSelected, -1);
  assert.strictEqual(s.selCount, 1);           // the selection itself survives
});

test('selectFiles only touches the items that match', () => {
  const items = [f('a.txt'), f('b.log'), f('c.txt')];
  const s = new G.SelectionModel({ count: 3 });
  const changed = s.selectFiles(items, (it) => it.name.endsWith('.txt'), true);
  assert.strictEqual(changed, 2);
  assert.deepStrictEqual([...s.selected].sort((a, b) => a - b), [0, 2]);
  assert.strictEqual(s.selectFiles(items, (it) => it.name.endsWith('.txt'), true), 0);
});

// ---------------------------------------------------------------------------
// Incremental search
// ---------------------------------------------------------------------------

const NAMES = ['alpha.txt', 'Beta.txt', 'beta2.txt', 'gamma.log'].map((n) => f(n));

test('incremental search: start-of-name mode, wrapping from the focused item', () => {
  assert.strictEqual(G.searchFile(NAMES, 'bet', { focusedIndex: 0 }), 1);
  assert.strictEqual(G.searchFile(NAMES, 'alp', { focusedIndex: 2 }), 0);     // wrapped
  assert.strictEqual(G.searchFile(NAMES, 'zzz', { focusedIndex: 0 }), -1);
  assert.strictEqual(G.searchFile([], 'a', {}), -1);
});

test('incremental search: skipCurrent and reverse', () => {
  assert.strictEqual(G.searchFile(NAMES, 'bet', { focusedIndex: 1 }), 1);
  assert.strictEqual(G.searchFile(NAMES, 'bet', { focusedIndex: 1, skipCurrent: true }), 2);
  assert.strictEqual(G.searchFile(NAMES, 'bet', { focusedIndex: 2, skipCurrent: true, reverse: true }), 1);
});

test('incremental search: whole-name and all-columns modes', () => {
  assert.strictEqual(G.searchFile(NAMES, 'amma', { mode: G.PANEL_SEARCH.NAME_START_ONLY }), -1);
  assert.strictEqual(G.searchFile(NAMES, 'amma', { mode: G.PANEL_SEARCH.NAME }), 3);

  const columns = [{ visible: true }, { visible: false }];
  const columnText = (item, c) => (c === 0 ? item.name : item.owner || '');
  const withOwner = [f('x', { owner: 'root' }), f('y', { owner: 'daemon' })];
  // The owner column is hidden, so a match in it must not count.
  assert.strictEqual(G.searchFile(withOwner, 'daemon',
    { mode: G.PANEL_SEARCH.ALL, columns, columnText }), -1);
  columns[1].visible = true;
  assert.strictEqual(G.searchFile(withOwner, 'daemon',
    { mode: G.PANEL_SEARCH.ALL, columns, columnText }), 1);
});

test('incremental search is case-sensitive once you type a capital', () => {
  assert.strictEqual(G.searchFile(NAMES, 'b', { focusedIndex: 0 }), 1);      // Beta
  assert.strictEqual(G.searchFile(NAMES, 'B', { focusedIndex: 0 }), 1);      // Beta only
  assert.strictEqual(G.searchFile(NAMES, 'B', { focusedIndex: 2 }), 1);
});

test('incrementalSearch reports whether there is a next match, and keeps state on a miss', () => {
  const state = new G.IncrementalSearchState();
  let r = G.incrementalSearch(NAMES, 'bet', state, { focusedIndex: 0 });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.index, 1);
  assert.strictEqual(state.searching, true);
  assert.strictEqual(state.text, 'bet');
  assert.strictEqual(state.haveNext, true);

  r = G.incrementalSearch(NAMES, 'gamma', state, { focusedIndex: 0 });
  assert.strictEqual(state.haveNext, false);    // only one match

  // A miss must not throw away the search you already had.
  r = G.incrementalSearch(NAMES, 'zzz', state, { focusedIndex: 0 });
  assert.strictEqual(r.found, false);
  assert.strictEqual(state.text, 'gamma');

  state.reset();
  assert.deepStrictEqual({ ...state }, { searching: false, text: '', haveNext: false });
});

test('the incremental search status line names the next-match shortcut only when there is one', () => {
  const state = new G.IncrementalSearchState();
  state.text = 'ab';
  state.haveNext = true;
  assert.ok(G.formatIncrementalSearchStatus(state).includes('ab'));
  state.haveNext = false;
  assert.ok(!G.formatIncrementalSearchStatus(state).includes('next'));
});

// ---------------------------------------------------------------------------
// Path history
// ---------------------------------------------------------------------------

test('path history: back and forward move the cursor without losing entries', () => {
  const h = new G.PathHistory({ path: '/a' });
  h.pathChanged('/b');
  h.pathChanged('/c');
  assert.strictEqual(h.backCount, 2);
  assert.strictEqual(h.forwardCount, 0);
  assert.strictEqual(h.currentPath, '/c');

  assert.strictEqual(h.go(-1), '/b');
  assert.strictEqual(h.backCount, 1);
  assert.strictEqual(h.forwardCount, 1);
  assert.strictEqual(h.historyPath(1), '/c');

  assert.strictEqual(h.go(-1), '/a');
  assert.strictEqual(h.backCount, 0);
  assert.strictEqual(h.forwardCount, 2);
  assert.strictEqual(h.canGoBack(), false);

  assert.strictEqual(h.go(2), '/c');
  assert.strictEqual(h.currentPath, '/c');
  assert.strictEqual(h.forwardCount, 0);
});

test('path history: going somewhere new drops the forward half', () => {
  const h = new G.PathHistory({ path: '/a' });
  h.pathChanged('/b');
  h.pathChanged('/c');
  h.go(-1);
  assert.strictEqual(h.forwardCount, 1);
  h.pathChanged('/d');
  assert.strictEqual(h.forwardCount, 0);
  assert.strictEqual(h.backCount, 2);
});

test('path history ignores a move to the same path and an empty start', () => {
  const h = new G.PathHistory({ path: '' });
  h.pathChanged('/a');
  assert.strictEqual(h.backCount, 0);       // nothing to remember from ''
  h.pathChanged('/a');
  assert.strictEqual(h.backCount, 0);
});

test('path history is trimmed from the old end while there is a back half', () => {
  const h = new G.PathHistory({ path: '/0', maxHistoryCount: 3 });
  for (let i = 1; i <= 6; i++) h.pathChanged('/' + i);
  assert.strictEqual(h.paths.length, 3);
  assert.strictEqual(h.backCount, 3);
  assert.deepStrictEqual(h.paths, ['/3', '/4', '/5']);
});

// ---------------------------------------------------------------------------
// History combo
// ---------------------------------------------------------------------------

test('saveToHistory puts the newest first, removes every duplicate and trims', () => {
  let list = G.saveToHistory([], 'a', 3);
  list = G.saveToHistory(list, 'b', 3);
  list = G.saveToHistory(list, 'a', 3);
  assert.deepStrictEqual(list, ['a', 'b']);
  list = G.saveToHistory(list, 'c', 3);
  list = G.saveToHistory(list, 'd', 3);
  assert.deepStrictEqual(list, ['d', 'c', 'a']);
  // An empty value is not recorded, but the trim still runs.
  assert.deepStrictEqual(G.saveToHistory(['x', 'y', 'z'], '', 2), ['x', 'y']);
});

test('HistoryCombo records on the events its saveOn set names', () => {
  const c = new G.HistoryCombo({ saveOn: [G.HISTORY_SAVE_ON.DROPDOWN] });
  c.text = 'host1';
  assert.strictEqual(c.exit(), false);
  assert.deepStrictEqual(c.items, []);
  assert.strictEqual(c.dropDown(), true);
  assert.deepStrictEqual(c.items, ['host1']);

  // Arrow keys save a value that is not in the list yet, so browsing does not
  // discard what the user typed.
  c.text = 'host2';
  assert.strictEqual(c.arrowKey(), true);
  assert.deepStrictEqual(c.items, ['host2', 'host1']);
  assert.strictEqual(c.arrowKey(), false);      // already there

  assert.strictEqual(c.clearHistory(), true);
  assert.deepStrictEqual(c.items, []);
});

test('HistoryCombo trims immediately when the limit is lowered', () => {
  const c = new G.HistoryCombo({ items: ['a', 'b', 'c', 'd'] });
  c.setMaxHistorySize(2);
  assert.deepStrictEqual(c.items, ['a', 'b']);
});

// ---------------------------------------------------------------------------
// Mask editing
// ---------------------------------------------------------------------------

test('makeDirectoryMask reuses the separator flavour already in the mask', () => {
  assert.strictEqual(G.makeDirectoryMask('a'), 'a/');
  assert.strictEqual(G.makeDirectoryMask('a/b'), 'a/b/');
  assert.strictEqual(G.makeDirectoryMask('a\\b'), 'a\\b\\');
  assert.strictEqual(G.makeDirectoryMask('a/'), 'a/');
});

test('composeMaskStr doubles delimiters so a literal one survives', () => {
  const r = G.composeMaskStr(['a;b', 'c|d'], false);
  assert.strictEqual(r.masks, 'a;;b; c||d');
});

test('composeMaskStr validates without the trailing separator it just added', () => {
  const r = G.composeMaskStr(['*>1M'], true);
  assert.strictEqual(r.masks, '*>1M/');
  // The version handed to the validator keeps the size condition at the end,
  // where the mask engine can still see it.
  assert.strictEqual(r.masksForValidation, '*>1M');
});

test('composeMaskStrAll builds the include | exclude form', () => {
  const c = G.composeMaskStrAll(['*.txt'], ['*.tmp'], ['src'], ['node_modules']);
  assert.strictEqual(c.masks, '*.txt; src/ | *.tmp; node_modules/');

  const onlyInclude = G.composeMaskStrAll(['*.txt'], [], [], []);
  assert.strictEqual(onlyInclude.masks, '*.txt');

  const onlyExclude = G.composeMaskStrAll([], ['*.tmp'], [], []);
  assert.strictEqual(onlyExclude.masks, '| *.tmp');
});

test('composed masks parse back into the four lists the dialog shows', () => {
  const c = G.composeMaskStrAll(['*.txt'], ['*.tmp'], ['src'], ['node_modules']);
  const back = G.decomposeMaskStr(c.masks, (s) => M.parse(s));
  assert.deepStrictEqual(back.includeFiles, ['*.txt']);
  assert.deepStrictEqual(back.excludeFiles, ['*.tmp']);
  assert.deepStrictEqual(back.includeDirectories, ['src/']);
  assert.deepStrictEqual(back.excludeDirectories, ['node_modules/']);
});

test('validateMaskEdit points at the offending characters', () => {
  assert.deepStrictEqual(G.validateMaskEdit('*.txt', M.validate), { ok: true });
  const bad = G.validateMaskEdit('*>notasize', M.validate);
  assert.strictEqual(bad.ok, false);
  assert.ok(typeof bad.start === 'number');
  assert.ok(bad.length > 0);
});

test('validateMaskEditAll reports which memo failed', () => {
  const good = G.composeMaskStrAll(['*.txt'], [], ['src'], []);
  assert.deepStrictEqual(G.validateMaskEditAll(good, M.validate), { ok: true });

  const bad = G.composeMaskStrAll(['*>notasize'], [], [], []);
  const r = G.validateMaskEditAll(bad, M.validate);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.directory, false);
});

// ---------------------------------------------------------------------------
// Directory tree
// ---------------------------------------------------------------------------

function tree() {
  return new G.DirectoryTree({ rootName: '<root>' });
}

test('DirectoryTree finds the root by any spelling of it', () => {
  const t = tree();
  assert.strictEqual(t.findNodeToPath('/'), t.root);
  assert.strictEqual(t.findNodeToPath(''), t.root);
  assert.strictEqual(t.root.name, '<root>');
});

test('DirectoryTree.loadPath creates every missing ancestor', () => {
  const t = tree();
  const node = t.loadPath('/var/www/html');
  assert.strictEqual(node.path, '/var/www/html');
  assert.strictEqual(node.parent.path, '/var/www');
  assert.strictEqual(node.parent.parent.path, '/var');
  assert.strictEqual(node.parent.parent.parent, t.root);
  assert.strictEqual(t.findNodeToPath('/var/www'), node.parent);
  // Loading it again returns the same node rather than duplicating it.
  assert.strictEqual(t.loadPath('/var/www/html'), node);
  assert.deepStrictEqual(t.pathTo('/var/www').map((n) => n.path), ['/', '/var', '/var/www']);
});

test('DirectoryTree binary search still finds a node after many siblings', () => {
  const t = tree();
  const names = [];
  for (let i = 0; i < 50; i++) names.push('dir' + i);
  for (const n of names) t.loadPath('/' + n);
  for (const n of names) {
    assert.strictEqual(t.findNodeToPath('/' + n).name, n, n);
  }
  assert.strictEqual(t.findNodeToPath('/nothere'), null);
});

test('DirectoryTree.updatePath adds new directories and drops the ones that went away', () => {
  const t = tree();
  t.updatePath(t.root, [d('a'), d('b'), f('note.txt'), { name: '.', type: 'dir' }]);
  assert.deepStrictEqual(t.root.children.map((c) => c.name), ['a', 'b']);

  t.updatePath(t.root, [d('a'), d('c')]);
  assert.deepStrictEqual(t.root.children.map((c) => c.name), ['a', 'c']);
});

test('DirectoryTree.updatePath honours the hidden and inaccessible switches', () => {
  const t = tree();
  t.updatePath(t.root, [d('.git'), d('locked', { inaccessible: true }), d('src')]);
  assert.deepStrictEqual(t.root.children.map((c) => c.name), ['locked', 'src']);

  const t2 = new G.DirectoryTree({ showHiddenDirs: true, showInaccesibleDirectories: false });
  t2.updatePath(t2.root, [d('.git'), d('locked', { inaccessible: true }), d('src')]);
  assert.deepStrictEqual(t2.root.children.map((c) => c.name), ['.git', 'src']);
});

test('DirectoryTree refuses to delete the node the selection is standing in', () => {
  const t = tree();
  t.updatePath(t.root, [d('a')]);
  t.loadPath('/a/deep');
  t.selectedPath = '/a/deep';

  t.updatePath(t.root, []);                       // 'a' is gone from the server
  assert.deepStrictEqual(t.root.children.map((c) => c.name), ['a']);
  assert.strictEqual(t.pendingDelete.length, 1);

  t.selectedPath = '/';
  assert.strictEqual(t.checkPendingDeletes(), 0);
  assert.deepStrictEqual(t.root.children, []);
});

test('DirectoryTree.findPathNode falls back to the nearest known ancestor', () => {
  const t = tree();
  t.loadPath('/var/www');
  assert.strictEqual(t.findPathNode('/var/www/missing/deeper').path, '/var/www');
  assert.strictEqual(t.findPathNode('/nothing/at/all'), t.root);
});

// ---------------------------------------------------------------------------
// Per-drive last path
// ---------------------------------------------------------------------------

test('LastPathsPerDrive remembers where you were on each drive', () => {
  const l = new G.LastPathsPerDrive({ directoryExists: (p) => p === path.resolve('C:\\work\\src') });
  l.pathChanged('C:\\work\\src');
  assert.deepStrictEqual(l.tryGetLastPath('C:'), { found: true, path: path.resolve('C:\\work\\src') });
  assert.deepStrictEqual(l.tryGetLastPath('D:'), { found: false, path: null });
});

test('LastPathsPerDrive falls back to the drive root when the path has gone', () => {
  const l = new G.LastPathsPerDrive({ directoryExists: () => false });
  l.pathChanged('C:\\gone');
  assert.deepStrictEqual(l.tryGetLastPath('C:'), { found: true, path: 'C:' });
});

test('LastPathsPerDrive keys a UNC share by server AND share', () => {
  assert.strictEqual(G.LastPathsPerDrive.driveKeyOf('\\\\srv\\share\\a\\b'), '\\\\srv\\share');
  assert.strictEqual(G.LastPathsPerDrive.driveKeyOf('d:\\x'), 'D');
  assert.strictEqual(G.LastPathsPerDrive.isRealDrive('C'), true);
  assert.strictEqual(G.LastPathsPerDrive.isRealDrive('\\\\srv\\share'), false);
  // GetDriveKey lower-cases the UNC form, so the case a user typed cannot split
  // one share into two remembered paths.
  assert.strictEqual(G.LastPathsPerDrive.driveKeyOf('\\\\SRV\\Share\\a'), '\\\\srv\\share');
  assert.strictEqual(
    G.LastPathsPerDrive.driveKeyOf('\\\\SRV\\Share\\a'),
    G.LastPathsPerDrive.driveKeyOf('\\\\srv\\share\\b'));
});

// ---------------------------------------------------------------------------
// The capability model (core/FileSystems.cpp)
// ---------------------------------------------------------------------------

const ADAPTERS = {
  local: 'LocalAdapter',
  sftp: 'SftpAdapter',
  scp: 'ScpAdapter',
  ftp: 'FtpAdapter',
  webdav: 'WebDavAdapter',
  s3: 'S3Adapter',
};

function adapterFor(id) {
  const Klass = require(`../design/main/protocols/${id}`)[ADAPTERS[id]];
  return new Klass({ host: 'example.invalid', user: 'u' });
}

test('the capability model is internally complete', () => {
  assert.strictEqual(FS.assertModelComplete(), true);
  assert.strictEqual(FS.CAPABILITIES.length, 40);          // fcCount in the C++
  assert.strictEqual(FS.CAPABILITIES[0], 'fcUserGroupListing');
  assert.strictEqual(FS.CAPABILITIES[FS.CAPABILITIES.length - 1], 'fcTags');
});

test('every adapter answers every capability with a boolean', () => {
  for (const id of Object.keys(ADAPTERS)) {
    const matrix = FS.capabilities(adapterFor(id));
    for (const name of FS.CAPABILITIES) {
      assert.strictEqual(typeof matrix[name], 'boolean', `${id}.${name}`);
    }
  }
});

test('capabilities are DERIVED from caps — flipping a cap flips the answer', () => {
  const adapter = adapterFor('sftp');
  assert.strictEqual(FS.isCapable(adapter, 'fcModeChanging'), true);
  adapter.caps.rights = false;
  assert.strictEqual(FS.isCapable(adapter, 'fcModeChanging'), false);
  assert.strictEqual(FS.isCapable(adapter, 'fcModeChangingUpload'), false);
  assert.strictEqual(FS.isCapable(adapter, 'fcIgnorePermErrors'), false);
  adapter.caps.rights = true;

  assert.strictEqual(FS.isCapable(adapter, 'fcResumeSupport'), true);
  adapter.caps.resume = false;
  assert.strictEqual(FS.isCapable(adapter, 'fcResumeSupport'), false);
  assert.strictEqual(FS.isCapable(adapter, 'fcParallelFileTransfers'), false);
});

test('every capability that claims to read a cap really does read it', () => {
  // The guarantee this file exists for: no capability may be a hard-coded
  // per-protocol constant hiding behind a caps key it ignores.
  for (const entry of FS.CAPABILITY_LIST) {
    if (entry.reads.length === 0) continue;
    let sensitive = false;
    for (const protocolId of Object.keys(FS.PROTOCOL_TRAITS)) {
      for (const key of entry.reads) {
        const probe = {
          protocolId,
          caps: Object.fromEntries(entry.reads.map((k) => [k, true])),
          setTimes() {}, createReadStream() {}, createWriteStream() {},
        };
        const traits = FS.traitsOf(probe);
        probe.caps[key] = true;
        const withKey = entry.derive(probe.caps, probe, traits);
        probe.caps[key] = false;
        const withoutKey = entry.derive(probe.caps, probe, traits);
        if (withKey !== withoutKey) sensitive = true;
      }
    }
    assert.ok(sensitive, `${entry.name} declares it reads ${entry.reads.join(', ')} but ignores them`);
  }
});

test('an unknown capability is an error, not a silent false', () => {
  assert.throws(() => FS.isCapable(adapterFor('sftp'), 'fcMadeUp'), /Unknown file-system capability/);
  assert.strictEqual(FS.isCapable(null, 'fcRename'), false);
});

test('protocol identification covers every shipped adapter', () => {
  assert.strictEqual(FS.protocolIdOf(adapterFor('sftp')), 'sftp');
  assert.strictEqual(FS.protocolIdOf(adapterFor('scp')), 'scp');
  assert.strictEqual(FS.protocolIdOf(adapterFor('ftp')), 'ftp');
  assert.strictEqual(FS.protocolIdOf(adapterFor('webdav')), 'webdav');
  assert.strictEqual(FS.protocolIdOf(adapterFor('s3')), 's3');
  assert.strictEqual(FS.protocolIdOf(adapterFor('local')), 'local');
});

test('SFTP and the local backend match WinSCP exactly', () => {
  assert.deepStrictEqual(FS.divergence(adapterFor('sftp')), []);
  // There is no TLocalFileSystem in the C++ (local browsing goes through the
  // dir view), so there is nothing to diverge from.
  assert.deepStrictEqual(FS.divergence(adapterFor('local')), []);
});

test('the divergences from WinSCP are exactly the recorded ones', () => {
  // A snapshot on purpose: if a cap changes and the gap list moves, this fails
  // and the ledger gets updated rather than the drift going unnoticed.
  const seen = {};
  for (const id of ['scp', 'ftp', 'webdav', 's3']) {
    seen[id] = FS.divergence(adapterFor(id)).map((r) => `${r.kind}:${r.capability}`).sort();
  }
  assert.deepStrictEqual(seen, {
    scp: [
      'extra:fcCheckingSpaceAvailable',     // `df` over the shell
      'extra:fcNewerOnlyUpload',
      'extra:fcTimestampChanging',          // `touch` over the shell
      'extra:fcTransferIn',
      'extra:fcTransferOut',
    ].sort(),
    ftp: [
      'gap:fcAnyCommand',                   // no raw-FTP-command surface yet
      'gap:fcModeChanging',                 // set from FEAT/SITE HELP on connect
      'gap:fcNewerOnlyUpload',              // set from MFMT/MDTM on connect
    ].sort(),
    webdav: [
      'extra:fcTransferIn',
      'extra:fcTransferOut',
      'gap:fcCheckingSpaceAvailable',       // set from RFC 4331 quota on connect
      'gap:fcPreservingTimestampUpload',
    ].sort(),
    s3: [
      'extra:fcCalculatingChecksum',        // ETag
      'extra:fcTransferIn',
      'extra:fcTransferOut',
      'gap:fcAclChangingFiles',
      'gap:fcLoadingAdditionalProperties',
      'gap:fcTags',
    ].sort(),
  });
});

test('server-detected capabilities close their gap once the server advertises them', () => {
  // FTP's mode-changing and newer-only-upload gaps are pre-connect artefacts:
  // the adapter learns them from FEAT, and the model must follow.
  const ftp = adapterFor('ftp');
  ftp.caps.rights = true;
  ftp.caps.timestamp = true;
  const after = FS.divergence(ftp).map((r) => r.capability);
  assert.ok(!after.includes('fcModeChanging'));
  assert.ok(!after.includes('fcNewerOnlyUpload'));

  const dav = adapterFor('webdav');
  dav.caps.spaceInfo = true;
  assert.ok(!FS.divergence(dav).map((r) => r.capability).includes('fcCheckingSpaceAvailable'));
});

test('a conditional WinSCP answer never counts as a divergence', () => {
  // fcHardLink is `depends` for SFTP (version 6 or the openssh extension), so
  // the adapter answering either way is still faithful.
  const sftp = adapterFor('sftp');
  assert.strictEqual(FS.WINSCP_REFERENCE.sftp.fcHardLink, FS.DEPENDS);
  sftp.caps.hardlink = true;
  assert.deepStrictEqual(FS.divergence(sftp), []);
  sftp.caps.hardlink = false;
  assert.deepStrictEqual(FS.divergence(sftp), []);
});

test('describe() gives the File System Information dialog its rows', () => {
  const rows = FS.describe(adapterFor('sftp'));
  assert.strictEqual(rows.length, 40);
  const rename = rows.find((r) => r.name === 'fcRename');
  assert.strictEqual(rename.supported, true);
  assert.ok(rename.doc.length > 0);
});

test('fcBackgroundTransfers is answered by the session, not the protocol', () => {
  // WinSCP answers this one in TTerminal: it is false only while file
  // encryption is on, whatever the file system says.
  const a = adapterFor('sftp');
  assert.strictEqual(FS.isCapable(a, 'fcBackgroundTransfers'), true);
  a.encryptingFiles = true;
  assert.strictEqual(FS.isCapable(a, 'fcBackgroundTransfers'), false);
});
