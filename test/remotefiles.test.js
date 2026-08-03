// remotefiles.test.js — the remote file model from core/RemoteFiles.cpp.
//
// The listing-parser table is the heart of this file. Every row is a real
// server WinSCP grew a branch for: MacOS ACL markers, Android BusyBox omitting
// the link count, SSHFS printing question marks, CygWin group names with
// spaces, device nodes with a 'major,' column, and the two different shapes of
// `ls --full-time`. A parser that handles only the textbook line is a parser
// that silently produces wrong files.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const R = require('../design/main/remotefiles');
const C = require('../design/main/common');

const BS = String.fromCharCode(92); // a literal backslash, kept unambiguous

/** Fixed clock so a listing line without a year is deterministic. */
const NOW = new Date(2020, 7, 1, 12, 0, 0, 0).getTime(); // 2020-08-01 local

// ---------------------------------------------------------------------------
// unix path arithmetic
// ---------------------------------------------------------------------------

test('isUnixStyleWindowsPath recognises the FTP-on-Windows shape', () => {
  assert.equal(R.isUnixStyleWindowsPath('C:/a'), true);
  assert.equal(R.isUnixStyleWindowsPath('C:/'), true);
  assert.equal(R.isUnixStyleWindowsPath('C:' + BS), false); // backslash is not it
  assert.equal(R.isUnixStyleWindowsPath('/C:/'), false);
  assert.equal(R.isUnixStyleWindowsPath('1:/a'), false);
  assert.equal(R.unixIsAbsolutePath('/a'), true);
  assert.equal(R.unixIsAbsolutePath('C:/a'), true);
  assert.equal(R.unixIsAbsolutePath('a/b'), false);
  assert.equal(R.unixIsAbsolutePath(''), false);
});

test('trailing slash helpers keep the root and the drive root intact', () => {
  assert.equal(R.unixIncludeTrailingBackslash('/a'), '/a/');
  assert.equal(R.unixIncludeTrailingBackslash('/a/'), '/a/');
  // An empty path stays empty; it used to become '/' and callers rely on it not.
  assert.equal(R.unixIncludeTrailingBackslash(''), '');
  assert.equal(R.unixExcludeTrailingBackslash('/a/'), '/a');
  assert.equal(R.unixExcludeTrailingBackslash('/'), '/');
  assert.equal(R.unixExcludeTrailingBackslash(''), '');
  // 'C:/' keeps its slash — without it the path becomes drive-relative.
  assert.equal(R.unixExcludeTrailingBackslash('C:/'), 'C:/');
  assert.equal(R.simpleUnixExcludeTrailingBackslash('C:/'), 'C:');
  assert.equal(R.unixExcludeTrailingBackslash('C:/a/'), 'C:/a');
});

test('unixCombinePaths, and the variant that tolerates an empty second part', () => {
  assert.equal(R.unixCombinePaths('/a', 'b'), '/a/b');
  assert.equal(R.unixCombinePaths('/a/', 'b'), '/a/b');
  // The plain combine adds the separator even with nothing to append.
  assert.equal(R.unixCombinePathsForce('/a', ''), '/a/');
  assert.equal(R.unixCombinePathsSmart('/a', ''), '/a');
  assert.equal(R.unixCombinePathsSmart('/a', 'b'), '/a/b');
  assert.equal(R.universalCombinePaths(true, '/a', 'b'), '/a/b');
  assert.equal(R.universalCombinePaths(false, 'C:' + BS + 'a', 'b'), 'C:' + BS + 'a' + BS + 'b');
});

test('unixSamePath and unixIsChildPath treat a path as its own child', () => {
  assert.equal(R.unixSamePath('/a', '/a/'), true);
  assert.equal(R.unixSamePath('/a', '/b'), false);
  assert.equal(R.unixIsChildPath('/a', '/a/b'), true);
  assert.equal(R.unixIsChildPath('/a', '/a'), true);
  assert.equal(R.unixIsChildPath('/a', '/ab'), false);
  assert.equal(R.unixIsChildPath('/a/b', '/a'), false);
});

test('unix path decomposition, including the empty results', () => {
  assert.equal(R.unixExtractFileDir('/a/b'), '/a');
  assert.equal(R.unixExtractFileDir('/a'), '/');
  assert.equal(R.unixExtractFileDir('a'), '');   // no slash, no directory
  assert.equal(R.unixExtractFilePath('/a/b'), '/a/');
  assert.equal(R.unixExtractFilePath('a'), '');  // not '/', deliberately
  assert.equal(R.unixExtractFileName('/a/b.txt'), 'b.txt');
  assert.equal(R.unixExtractFileName('b.txt'), 'b.txt');
  assert.equal(R.unixExtractFileName('/a/'), '');
  assert.equal(R.unixExtractFileExt('b.tar.gz'), '.gz');
  assert.equal(R.unixExtractFileExt('noext'), '');
  assert.equal(R.unixExtractFileExt('/a.b/c.txt'), '.txt');
  // A dot-file is its own extension: the C++ takes LastDelimiter('.') > 0 on a
  // 1-based index, so position 1 counts, and Delphi's ExtractFileExt agrees.
  assert.equal(R.unixExtractFileExt('.hidden'), '.hidden');
  // The quirk: the dot is found inside the NAME but sliced out of the PATH, so
  // a dotted directory with an extension-less name still yields nothing.
  assert.equal(R.unixExtractFileExt('/a.b/c'), '');
  assert.equal(R.extractFileName('/a/b', true), 'b');
  assert.equal(R.extractShortName('/a/', true), '/a/'); // falls back to the whole path
  assert.equal(R.isUnixRootPath(''), true);
  assert.equal(R.isUnixRootPath('/'), true);
  assert.equal(R.isUnixRootPath('/a'), false);
});

test('isUnixHiddenFile does not count the . and .. entries', () => {
  assert.equal(R.isUnixHiddenFile('.bashrc'), true);
  assert.equal(R.isUnixHiddenFile('visible'), false);
  assert.equal(R.isUnixHiddenFile('.'), false);
  assert.equal(R.isUnixHiddenFile('..'), false);
});

test('absolutePath collapses .. and ., and stops at the root', () => {
  assert.equal(R.absolutePath('/home/u', 'a/../b'), '/home/u/b');
  assert.equal(R.absolutePath('/home/u', '../x'), '/home/x');
  assert.equal(R.absolutePath('/home/u', './x'), '/home/u/x');
  assert.equal(R.absolutePath('/a', '/b/'), '/b');       // absolute wins
  assert.equal(R.absolutePath('/a', ''), '/a');          // empty means "here"
  // The root has no parent; asking for one lands back on the root.
  assert.equal(R.absolutePath('/', '../x'), '/');
  assert.equal(R.absolutePath('/a/b/c', '../../d'), '/a/d');
  // FTP on Windows uses Unix separators in drive-qualified absolute paths.
  assert.equal(R.absolutePath('C:/home/u', 'C:/other/file'), 'C:/other/file');
});

test('extractCommonPath finds the deepest shared directory, or fails', () => {
  assert.deepEqual(R.unixExtractCommonPath(['/a/b/x', '/a/b/y']), { ok: true, path: '/a/b/' });
  assert.deepEqual(R.unixExtractCommonPath(['/a/b/x', '/a/c/y']), { ok: true, path: '/a/' });
  assert.deepEqual(R.unixExtractCommonPath(['/a/x', '/b/y']), { ok: true, path: '/' });
  // A bare name has no path at all, so there is nothing in common.
  assert.deepEqual(R.unixExtractCommonPath(['x', 'y']), { ok: false, path: '' });
  assert.deepEqual(R.unixExtractCommonPath([]), { ok: false, path: '' });
  // Objects are read through their fullFileName, as the file list stores them.
  assert.deepEqual(
    R.unixExtractCommonPath([{ fullFileName: '/a/b/x' }, { fullFileName: '/a/b/y' }]),
    { ok: true, path: '/a/b/' });
  const remoteList = new R.TRemoteFileList();
  remoteList.directory = '/a/b';
  const remoteX = fileNamed('x', false, 1);
  const remoteY = fileNamed('y', false, 1);
  remoteList.addFile(remoteX);
  remoteList.addFile(remoteY);
  const cloned = R.TRemoteFileList.cloneStrings([
    { name: 'x', file: remoteX }, { name: 'y', file: remoteY },
  ]);
  assert.deepEqual(R.unixExtractCommonPath(cloned), { ok: true, path: '/a/b/' });
  assert.deepEqual(R.extractCommonPath([
    { fullFileName: 'C:' + BS + 'a' + BS + 'x' },
    { fullFileName: 'C:' + BS + 'a' + BS + 'y' },
  ]), { ok: true, path: 'C:' + BS + 'a' + BS });
  assert.deepEqual(R.extractCommonPath(['C:' + BS + 'a' + BS + 'x', 'C:' + BS + 'a' + BS + 'y']),
    { ok: true, path: 'C:' + BS + 'a' + BS });
});

test('minimizeName eats directories from the left, keeping name and drive', () => {
  assert.equal(R.minimizeName('/home/martin/documents/file.txt', 20, true), '/.../file.txt');
  assert.equal(R.minimizeName('/home/martin/documents/file.txt', 40, true),
    '/home/martin/documents/file.txt');
  // Once even '/.../name' is too long, the name itself is truncated.
  assert.equal(R.minimizeName('/home/martin/documents/file.txt', 12, true), '.../file.txt');
  assert.equal(
    R.minimizeName('C:' + BS + 'Users' + BS + 'martin' + BS + 'docs' + BS + 'file.txt', 20, false),
    'C:' + BS + '...' + BS + 'docs' + BS + 'file.txt');
});

test('makeFileList quotes only what needs it', () => {
  assert.equal(R.makeFileList(['a.txt', 'b c.txt']), 'a.txt "b c.txt"');
  assert.equal(R.makeFileList([]), '');
});

test('VMS revision suffixes are trimmed only when the session asks', () => {
  assert.equal(R.trimVmsVersion('LOGIN.COM;3', true), 'LOGIN.COM');
  assert.equal(R.trimVmsVersion('LOGIN.COM;3', false), 'LOGIN.COM;3');
  // A leading semicolon is not a version — position must be past the first char.
  assert.equal(R.trimVmsVersion(';3', true), ';3');
  assert.equal(R.hasVmsVersion('LOGIN.COM;3'), true);
  assert.equal(R.hasVmsVersion('A;1'), true);
  assert.equal(R.hasVmsVersion('LOGIN.COM'), false);
});

test('the multi-files-to-one confirmation names the missing slash', () => {
  const msg = R.formatMultiFilesToOneConfirmation('/home/u/target', true);
  assert.match(msg, /single file 'target'/);
  assert.match(msg, /directory '\/home\/u'/);
  assert.match(msg, /terminate the path with a slash/);
  // It is a main instruction, so the dialog highlights the question.
  assert.equal(msg.startsWith(C.MAIN_MSG_TAG), true);
});

// ---------------------------------------------------------------------------
// modification precision
// ---------------------------------------------------------------------------

test('reduceDateTimePrecision zeroes what the server never told us', () => {
  const ms = new Date(2020, 5, 15, 12, 34, 56, 789).getTime();
  assert.equal(R.reduceDateTimePrecision(ms, R.MODIFICATION_FMT.FULL), ms);
  assert.equal(R.reduceDateTimePrecision(ms, R.MODIFICATION_FMT.NONE), 0);
  assert.equal(R.reduceDateTimePrecision(ms, R.MODIFICATION_FMT.MDHM),
    new Date(2020, 5, 15, 12, 34, 0, 0).getTime());
  assert.equal(R.reduceDateTimePrecision(ms, R.MODIFICATION_FMT.YMDHM),
    new Date(2020, 5, 15, 12, 34, 0, 0).getTime());
  assert.equal(R.reduceDateTimePrecision(ms, R.MODIFICATION_FMT.MDY),
    new Date(2020, 5, 15, 0, 0, 0, 0).getTime());
});

test('lessDateTimePrecision picks the coarser of the two', () => {
  const F = R.MODIFICATION_FMT;
  assert.equal(R.lessDateTimePrecision(F.FULL, F.MDHM), F.MDHM);
  assert.equal(R.lessDateTimePrecision(F.MDY, F.FULL), F.MDY);
  assert.equal(R.lessDateTimePrecision(F.NONE, F.MDY), F.NONE);
});

test('two timestamps are equal at the coarser precision — the sync rule', () => {
  const F = R.MODIFICATION_FMT;
  const local = new Date(2020, 5, 15, 12, 34, 56, 0).getTime();
  const remote = new Date(2020, 5, 15, 12, 34, 0, 0).getTime();
  // Full against full: 56 seconds apart, so genuinely different.
  assert.equal(R.sameModification(local, F.FULL, remote, F.FULL), false);
  // The remote only ever had minutes, so the seconds must not count.
  assert.equal(R.sameModification(local, F.FULL, remote, F.MDHM), true);
  // At date-only precision even a different hour is the same day.
  const evening = new Date(2020, 5, 15, 23, 0, 0, 0).getTime();
  assert.equal(R.sameModification(local, F.FULL, evening, F.MDY), true);
  assert.equal(R.sameModification(local, F.MDY, evening, F.FULL), true);
  // A whole day apart is still different at date precision.
  const nextDay = new Date(2020, 5, 16, 12, 34, 56, 0).getTime();
  assert.equal(R.sameModification(local, F.MDY, nextDay, F.MDY), false);
  assert.equal(R.compareModification(local, F.MDY, nextDay, F.MDY) < 0, true);
  // The two-second FAT tolerance still applies on top.
  assert.equal(R.sameModification(local, F.FULL, local + 1999, F.FULL), true);
  assert.equal(R.sameModification(local, F.FULL, local + 2000, F.FULL), false);
});

test('modificationStr reproduces the ls shapes exactly', () => {
  const F = R.MODIFICATION_FMT;
  const ms = new Date(2019, 5, 5, 9, 4, 3, 0).getTime();
  assert.equal(R.modificationStr(ms, F.NONE), '');
  assert.equal(R.modificationStr(ms, F.MDHM), 'Jun  5  9:04');
  assert.equal(R.modificationStr(ms, F.YMDHM), 'Jun  5  9:04 2019');
  assert.equal(R.modificationStr(ms, F.FULL), 'Jun  5  9:04:03 2019');
  assert.equal(R.modificationStr(ms, F.MDY), 'Jun  5 2019');
});

test('userModificationStr shows only the precision that exists', () => {
  const F = R.MODIFICATION_FMT;
  const ms = new Date(2019, 5, 5, 9, 4, 3, 0).getTime();
  assert.equal(R.userModificationStr(ms, F.NONE), '');
  assert.equal(R.userModificationStr(ms, F.MDY), '2019-06-05');
  assert.equal(R.userModificationStr(ms, F.MDHM), '2019-06-05 09:04');
  assert.equal(R.userModificationStr(ms, F.FULL), '2019-06-05 09:04:03');
  // A caller may localize it without the module knowing anything about locales.
  assert.equal(R.userModificationStr(ms, F.FULL, () => 'custom'), 'custom');
});

test('time shifting only applies where a time is actually known', () => {
  const F = R.MODIFICATION_FMT;
  const ms = new Date(2019, 5, 5, 9, 0, 0, 0).getTime();
  assert.equal(R.isTimeShiftingApplicable(F.MDHM), true);
  assert.equal(R.isTimeShiftingApplicable(F.FULL), true);
  // Shifting a made-up midnight would be meaningless.
  assert.equal(R.isTimeShiftingApplicable(F.MDY), false);
  assert.equal(R.isTimeShiftingApplicable(F.NONE), false);
  assert.equal(R.shiftTimeInSeconds(ms, F.FULL, 3600), ms + 3600000);
  assert.equal(R.shiftTimeInSeconds(ms, F.MDY, 3600), ms);
  assert.equal(R.shiftTimeInSeconds(ms, F.FULL, 0), ms);
});

test('getPartialFileExtLen recognises the .filepart marker and its counter', () => {
  assert.equal(R.getPartialFileExtLen('a.txt.filepart'), 9);
  assert.equal(R.getPartialFileExtLen('a.txt.FILEPART'), 9);   // case-insensitive
  assert.equal(R.getPartialFileExtLen('a.txt.filepart.3'), 11);
  assert.equal(R.getPartialFileExtLen('a.txt'), 0);
  assert.equal(R.getPartialFileExtLen('filepart'), 0);
});

test('sameUserName ignores the @host a few servers append', () => {
  assert.equal(R.sameUserName('martin@host', 'martin'), true);
  assert.equal(R.sameUserName('Martin', 'martin'), true);
  assert.equal(R.sameUserName('martin', 'root'), false);
});

test('fileTypeName classifies the ls type character', () => {
  assert.equal(R.fileTypeName('-'), 'file');
  assert.equal(R.fileTypeName('d'), 'dir');
  assert.equal(R.fileTypeName('l'), 'link');
  assert.equal(R.fileTypeName('b'), 'block-device');
  assert.equal(R.fileTypeName('c'), 'character-device');
  assert.equal(R.fileTypeName('p'), 'fifo');
  assert.equal(R.fileTypeName('s'), 'socket');
  // An unknown character still lists, as "special", rather than failing.
  assert.equal(R.fileTypeName('D'), 'dir');
  assert.equal(R.fileTypeName('?'), 'special');
});

// ---------------------------------------------------------------------------
// TRights
// ---------------------------------------------------------------------------

test('rights convert between octal, text and the mode string', () => {
  const r = new R.TRights(0o755);
  assert.equal(r.text, 'rwxr-xr-x');
  assert.equal(r.octal, '0755');
  assert.equal(r.number, 0o755);
  assert.equal(r.numberDecadic, 755);
  assert.equal(r.isUndef, false);
  assert.equal(r.unknown, false);
  assert.equal(r.getChmodStr(0), '0755');
  // A directory needs the fifth zero for coreutils to clear setuid/setgid.
  assert.equal(r.getChmodStr(1), '00755');

  const t = new R.TRights();
  t.text = 'rw-r--r--';
  assert.equal(t.octal, '0644');
  t.octal = '600';                 // three digits are accepted and padded
  assert.equal(t.text, 'rw-------');
  assert.equal(t.octal, '0600');
});

test('special bits round trip through their symbolic letters', () => {
  const r = new R.TRights();
  r.allowUndef = true;
  r.text = 'rwsr-Sr-T';
  // 's' = setuid AND execute; 'S'/'T' = the special bit WITHOUT execute.
  assert.equal(r.octal, '7744');
  assert.equal(r.text, 'rwsr-Sr-T');
  assert.equal(r.getRight(R.RIGHT.UserIDExec), true);
  assert.equal(r.getRight(R.RIGHT.UserExec), true);
  assert.equal(r.getRight(R.RIGHT.GroupIDExec), true);
  assert.equal(r.getRight(R.RIGHT.GroupExec), false);
  assert.equal(r.getRight(R.RIGHT.StickyBit), true);
  assert.equal(r.getRight(R.RIGHT.OtherExec), false);

  const combined = new R.TRights(0o4755);
  assert.equal(combined.text, 'rwsr-xr-x');
  const extended = new R.TRights(0o4644);
  assert.equal(extended.text, 'rwSr--r--');
});

test('Win32-OpenSSH * means unset, exactly like -', () => {
  const r = new R.TRights();
  r.text = 'rw-r**r**';
  assert.equal(r.octal, '0644');
});

test('an unparsable rights column is kept verbatim rather than rewritten', () => {
  const r = new R.TRights();
  r.allowUndef = true;
  r.text = '?????????';
  // Every bit reads as set, but the original text survives for display.
  assert.equal(r.text, '?????????');
  assert.equal(r.unknown, false);
  // A wrong length or a space is refused outright.
  assert.throws(() => { new R.TRights().text = 'rw-r--r-'; }, R.RightsError);
  assert.throws(() => { new R.TRights().text = 'rw- --r--'; }, R.RightsError);
  // '$' is only allowed once undefined bits are permitted.
  assert.throws(() => { new R.TRights().text = 'rw$r--r--'; }, R.RightsError);
  const undef = new R.TRights();
  undef.allowUndef = true;
  undef.text = 'rw$r--r--';
  assert.equal(undef.getRightUndef(R.RIGHT.UserExec), R.RIGHT_STATE.Undef);
  assert.throws(() => { new R.TRights().octal = '999'; }, R.RightsError);
  assert.throws(() => { new R.TRights().octal = '75'; }, R.RightsError);
});

test('setTextOverride carries a notation we cannot decode', () => {
  const r = new R.TRights();
  assert.equal(r.unknown, true);
  r.setTextOverride('server-specific');
  assert.equal(r.text, 'server-specific');
  assert.equal(r.unknown, false);
});

test('intersecting two rights leaves the disagreements undefined', () => {
  // This is exactly what the properties dialog does for a multi-file selection.
  const a = new R.TRights(0o644);
  const b = new R.TRights(0o664);
  a.allowUndef = true;
  b.allowUndef = true;
  a.andAssign(b);
  assert.equal(a.isUndef, true);
  assert.equal(a.text, 'rw-r$-r--');
  assert.equal(a.getRightUndef(R.RIGHT.GroupWrite), R.RIGHT_STATE.Undef);
  assert.equal(a.getRightUndef(R.RIGHT.UserRead), R.RIGHT_STATE.Yes);
  // With a partially undefined set, chmod has to go symbolically.
  assert.equal(a.getChmodStr(0), a.modeStr);
  assert.match(a.modeStr, /^u\+rw-xs,/);

  // Without allowUndef it is a plain numeric intersection.
  const c = new R.TRights(0o644);
  c.andAssign(new R.TRights(0o664));
  assert.equal(c.isUndef, false);
  assert.equal(c.octal, '0644');
});

test('rights equality respects whether undefined is in play', () => {
  const a = new R.TRights(0o644);
  const b = new R.TRights(0o644);
  assert.equal(a.equals(b), true);
  assert.equal(a.equals(0o644), true);
  assert.equal(a.equals(0o755), false);
  b.allowUndef = true;
  b.setRightUndef(R.RIGHT.GroupRead, R.RIGHT_STATE.Undef);
  // Once one side has an undefined bit, comparison is per-bit, not numeric.
  assert.equal(a.equals(b), false);
});

test('addExecute grants x wherever r or w is granted', () => {
  const r = new R.TRights(0o640);
  r.addExecute();
  assert.equal(r.octal, '0750');
  // A group with no access at all does not gain execute.
  const none = new R.TRights(0o600);
  none.addExecute();
  assert.equal(none.octal, '0700');
});

test('allUndef, readOnly and combine', () => {
  // The two accessors disagree in WinSCP and the disagreement is observable:
  // the getter reports true when all write bits are PRESENT, while the setter
  // clears them for true. Ported as written, asserted as written.
  const r = new R.TRights(0o777);
  assert.equal(r.readOnly, true);
  r.readOnly = true;
  assert.equal(r.octal, '0555');
  assert.equal(r.readOnly, false);
  r.readOnly = false;
  assert.equal(r.octal, '0777');

  const u = new R.TRights(0o644);
  u.allowUndef = true;
  u.allUndef();
  assert.equal(u.isUndef, true);
  assert.equal(u.text, '$'.repeat(9));

  // Combine: the other set's granted bits go on, its denied bits come off.
  const base = new R.TRights(0o600);
  const overlay = new R.TRights();
  overlay.allowUndef = true;
  overlay.allUndef();
  overlay.setRightUndef(R.RIGHT.GroupRead, R.RIGHT_STATE.Yes);
  overlay.setRightUndef(R.RIGHT.UserWrite, R.RIGHT_STATE.No);
  const combined = base.combine(overlay);
  assert.equal(combined.octal, '0440');
  assert.equal(combined.isUndef, false);
});

test('the flag/right/level arithmetic lines up with the octal constants', () => {
  assert.equal(R.TRights.rightToFlag(R.RIGHT.UserIDExec), R.FLAG.SetUID);
  assert.equal(R.TRights.rightToFlag(R.RIGHT.OtherExec), R.FLAG.OtherExec);
  assert.equal(R.TRights.rightToFlag(R.RIGHT.UserRead), R.FLAG.UserRead);
  assert.equal(
    R.TRights.calculateRight(R.RIGHT_GROUP.Group, R.RIGHT_LEVEL.Write), R.RIGHT.GroupWrite);
  assert.equal(
    R.TRights.calculateRight(R.RIGHT_GROUP.Other, R.RIGHT_LEVEL.Special), R.RIGHT.StickyBit);
  assert.equal(
    R.TRights.calculateFlag(R.RIGHT_GROUP.Other, R.RIGHT_LEVEL.Read), R.FLAG.OtherRead);
  assert.equal(
    R.TRights.calculatePermissions(R.RIGHT_GROUP.User, R.RIGHT_LEVEL.Read, R.RIGHT_LEVEL.Write),
    R.FLAG.UserRead | R.FLAG.UserWrite);
});

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

test('a token may have a name, an id, both or neither', () => {
  const named = new R.TRemoteToken('martin');
  assert.equal(named.isSet, true);
  assert.equal(named.nameValid, true);
  assert.equal(named.idValid, false);
  assert.equal(named.displayText, 'martin');

  const numeric = new R.TRemoteToken();
  numeric.id = 1000;
  assert.equal(numeric.isSet, true);
  assert.equal(numeric.displayText, '1000');
  assert.equal(numeric.logText, '"" [1000]');

  const empty = new R.TRemoteToken();
  assert.equal(empty.isSet, false);
  assert.equal(empty.displayText, '');

  // Clear drops the id but keeps the name, exactly as TRemoteToken::Clear does.
  const both = new R.TRemoteToken('martin');
  both.id = 1000;
  both.clear();
  assert.equal(both.name, 'martin');
  assert.equal(both.idValid, false);
});

test('token equality uses the id only when both sides have one', () => {
  const a = new R.TRemoteToken('martin');
  const b = new R.TRemoteToken('martin');
  assert.equal(a.equals(b), true);
  b.id = 1000;
  assert.equal(a.equals(b), false);
  a.id = 1000;
  assert.equal(a.equals(b), true);
  a.id = 1001;
  assert.equal(a.equals(b), false);
});

test('named tokens sort before numeric ones, numeric before empty', () => {
  const named = new R.TRemoteToken('abc');
  const other = new R.TRemoteToken('abd');
  const numeric = new R.TRemoteToken();
  numeric.id = 5;
  const empty = new R.TRemoteToken();
  assert.equal(named.compare(other) < 0, true);
  assert.equal(named.compare(numeric) < 0, true);
  assert.equal(numeric.compare(named) > 0, true);
  assert.equal(numeric.compare(empty) < 0, true);
  assert.equal(empty.compare(empty) === 0, true);
});

test('a token list indexes by name and id, and ignores an empty token', () => {
  const list = new R.TRemoteTokenList();
  const martin = new R.TRemoteToken('martin');
  martin.id = 1000;
  list.addUnique(martin);
  const dup = new R.TRemoteToken('other');
  dup.id = 1000;
  list.addUnique(dup);          // same id: already present
  list.addUnique(new R.TRemoteToken('users'));
  list.addUnique(new R.TRemoteToken('users'));  // same name: already present
  list.addUnique(new R.TRemoteToken());         // neither: dropped (winsshd/SFTP)

  assert.equal(list.count, 2);
  assert.equal(list.exists('martin'), true);
  assert.equal(list.exists('nobody'), false);
  assert.equal(list.findById(1000).name, 'martin');
  assert.equal(list.findByName('users').name, 'users');
  assert.equal(list.findById(9999), null);
  assert.deepEqual(list.logLines('users'),
    ['Following users found:', '  "martin" [1000]', '  "users" [0]']);
  assert.deepEqual(new R.TRemoteTokenList().logLines('groups'), ['No groups found.']);
  assert.equal(list.duplicate().count, 2);
});

// ---------------------------------------------------------------------------
// TRemoteFile — the listing parser
// ---------------------------------------------------------------------------

function parse(line, options) {
  const file = new R.TRemoteFile();
  file.setListingStr(line, Object.assign({ now: NOW, dstMode: 'unix' }, options || {}));
  return file;
}

test('a textbook ls line', () => {
  const f = parse('-rw-r--r--   1 martin users        1234 Jun 15 12:34 hello.txt');
  assert.equal(f.fileName, 'hello.txt');
  assert.equal(f.type, '-');
  assert.equal(f.isDirectory, false);
  assert.equal(f.size, 1234);
  assert.equal(f.iNodeBlocks, 1);
  assert.equal(f.owner.name, 'martin');
  assert.equal(f.group.name, 'users');
  assert.equal(f.rights.text, 'rw-r--r--');
  assert.equal(f.modificationFmt, R.MODIFICATION_FMT.MDHM);
  assert.equal(new Date(f.modification).getFullYear(), 2020);
  assert.equal(new Date(f.modification).getMonth(), 5);
  assert.equal(new Date(f.modification).getHours(), 12);
  assert.equal(new Date(f.modification).getMinutes(), 34);
  assert.equal(f.lastAccess, f.modification);
});

test('a name containing spaces keeps every one of them', () => {
  const f = parse('-rw-r--r--   1 martin users        1234 Jun 15 12:34 hello  world.txt');
  assert.equal(f.fileName, 'hello  world.txt');
});

test('a directory line, and the size a directory reports', () => {
  const f = parse('drwxr-xr-x   4 martin users        4096 Jun 15 12:34 docs');
  assert.equal(f.isDirectory, true);
  assert.equal(f.fileName, 'docs');
  // A directory's own size is meaningless and reads as zero...
  assert.equal(f.size, 0);
  // ...but the raw number is still what the regenerated listing prints.
  assert.match(f.listingStr, /4096/);
});

test('a symlink keeps its target, and one without a target is refused', () => {
  const f = parse('lrwxrwxrwx   1 root root            7 Jun 15 12:34 link -> /etc/hosts');
  assert.equal(f.isSymLink, true);
  assert.equal(f.fileName, 'link');
  assert.equal(f.linkTo, '/etc/hosts');
  // Without ' -> ' the line is not a symlink line, whatever the type says.
  assert.throws(
    () => parse('lrwxrwxrwx   1 root root            7 Jun 15 12:34 link'),
    R.ListLineError);
  // An arrow without a destination is just as unusable as no arrow at all.
  assert.throws(
    () => parse('lrwxrwxrwx   1 root root            7 Jun 15 12:34 link -> '),
    R.ListLineError);
});

test('MacOS ACL and extended-attribute markers after the rights column', () => {
  const plus = parse('-rw-r--r--+  1 martin users        1234 Jun 15 12:34 acl.txt');
  assert.equal(plus.fileName, 'acl.txt');
  assert.equal(plus.iNodeBlocks, 1);
  const at = parse('-rw-r--r--@  1 martin users        1234 Jun 15 12:34 xattr.txt');
  assert.equal(at.fileName, 'xattr.txt');
  const dot = parse('-rw-r--r--.  1 martin users        1234 Jun 15 12:34 selinux.txt');
  assert.equal(dot.fileName, 'selinux.txt');
  // On MacOS the marker can be preceded by a space.
  const spaced = parse('-rw-r--r-- @  1 martin users        1234 Jun 15 12:34 spaced.txt');
  assert.equal(spaced.fileName, 'spaced.txt');
});

test('Android BusyBox omits the link-count column', () => {
  const f = parse('-rw-r--r-- martin users 1234 Jun 15 12:34 busybox.txt');
  assert.equal(f.iNodeBlocks, 0);
  assert.equal(f.owner.name, 'martin');
  assert.equal(f.group.name, 'users');
  assert.equal(f.size, 1234);
  assert.equal(f.fileName, 'busybox.txt');
});

test('SSHFS prints question marks when it cannot stat', () => {
  const f = parse('d????????? ? ? ? ? ? unreadable');
  assert.equal(f.fileName, 'unreadable');
  assert.equal(f.isDirectory, true);
  assert.equal(f.modificationFmt, R.MODIFICATION_FMT.NONE);
  assert.equal(f.modification, 0);
  assert.equal(f.size, 0);
  // The permission column cannot be decoded, so it is shown as the server sent it.
  assert.equal(f.rightsStr, '?????????');
});

test('a group name containing a space is read until a size appears', () => {
  const f = parse('-rw-r--r--  1 martin  domain users  1234 Jun 15 12:34 cygwin.txt');
  assert.equal(f.owner.name, 'martin');
  assert.equal(f.group.name, 'domain users');
  assert.equal(f.size, 1234);
  assert.equal(f.fileName, 'cygwin.txt');
});

test('a device node has a major, column where the size would be', () => {
  const f = parse('crw-rw-rw-  1 root  wheel    3,   2 Jun 15 12:34 null');
  assert.equal(f.fileName, 'null');
  assert.equal(f.owner.name, 'root');
  assert.equal(f.group.name, 'wheel');
  assert.equal(R.fileTypeName(f.type), 'character-device');
  // The minor number lands in the size column, as it does in WinSCP.
  assert.equal(f.size, 2);
});

test('both shapes of ls --full-time', () => {
  const iso = parse('-rw-r--r-- 1 u g 5 2019-06-15 12:34:56.000000000 +0200 full.txt');
  assert.equal(iso.fileName, 'full.txt');
  assert.equal(iso.modificationFmt, R.MODIFICATION_FMT.FULL);
  assert.equal(new Date(iso.modification).getFullYear(), 2019);
  assert.equal(new Date(iso.modification).getSeconds(), 56);
  assert.equal(iso.size, 5);

  const dayName = parse('-rw-r--r-- 1 u g 5 Sat Jun 15 12:34:56 2019 full2.txt');
  assert.equal(dayName.fileName, 'full2.txt');
  assert.equal(dayName.modificationFmt, R.MODIFICATION_FMT.FULL);
  assert.equal(new Date(dayName.modification).getFullYear(), 2019);
  assert.equal(new Date(dayName.modification).getSeconds(), 56);

  // A short seconds field in the ISO form is tolerated.
  const noSec = parse('-rw-r--r-- 1 u g 5 2019-06-15 12:34 +0200 short.txt');
  assert.equal(new Date(noSec.modification).getSeconds(), 0);
});

test('an old entry carries a year instead of a time', () => {
  const f = parse('-rw-r--r-- 1 u g 5 Jun 15  2019 old.txt');
  assert.equal(f.modificationFmt, R.MODIFICATION_FMT.MDY);
  assert.equal(new Date(f.modification).getFullYear(), 2019);
  assert.equal(new Date(f.modification).getHours(), 0);
  assert.equal(f.fileName, 'old.txt');
});

test('the dd mmm column order some systems use', () => {
  const f = parse('-rw-r--r-- 1 u g 5 15 Jun 12:34 dm.txt');
  assert.equal(f.fileName, 'dm.txt');
  assert.equal(new Date(f.modification).getDate(), 15);
  assert.equal(new Date(f.modification).getMonth(), 5);
  assert.equal(new Date(f.modification).getHours(), 12);
});

test('a timeless entry dated in the future belongs to last year', () => {
  // Clock is 2020-08-01; a December entry cannot be this year.
  const december = parse('-rw-r--r-- 1 u g 5 Dec 25 12:34 xmas.txt');
  assert.equal(new Date(december.modification).getFullYear(), 2019);
  // The same day as "now" is this year.
  const today = parse('-rw-r--r-- 1 u g 5 Aug  1 09:00 today.txt');
  assert.equal(new Date(today.modification).getFullYear(), 2020);
  // Tomorrow is not; it must be last year's.
  const tomorrow = parse('-rw-r--r-- 1 u g 5 Aug  2 09:00 tomorrow.txt');
  assert.equal(new Date(tomorrow.modification).getFullYear(), 2019);
});

test('the six-character time-or-year field protects a leading space in a name', () => {
  // The separator space belongs to the fixed-width field, so a name that
  // genuinely starts with a space survives.
  const f = parse('-rw-r--r-- 1 u g 5 Jun 15 12:34  leading.txt');
  assert.equal(f.fileName, ' leading.txt');
});

test('a line that fits no known shape is refused, not guessed at', () => {
  assert.throws(() => parse(''), R.ListLineError);
  assert.throws(() => parse('total 12'), R.ListLineError);
  assert.throws(() => parse('-rw-r--r-'), R.ListLineError);
  // A month that is not a month.
  assert.throws(() => parse('-rw-r--r-- 1 u g 5 Foo 15 12:34 x'), R.ListLineError);
  // A day outside 1..31.
  assert.throws(() => parse('-rw-r--r-- 1 u g 5 Jun 45 12:34 x'), R.ListLineError);
  // An hour outside 0..23.
  assert.throws(() => parse('-rw-r--r-- 1 u g 5 Jun 15 44:34 x'), R.ListLineError);
  const err = (() => { try { parse('total 12'); } catch (e) { return e; } return null; })();
  assert.equal(err.line, 'total 12');
  assert.match(err.message, /Unexpected directory listing line/);
});

test('a metadata-only listing row is refused as malformed', () => {
  assert.throws(() => parse('-rw-r--r-- 1 u g 5 Jun 15 12:34 '), R.ListLineError);
});

test('tabs are treated as column separators', () => {
  const f = parse('-rw-r--r--\t1\tmartin\tusers\t1234\tJun 15 12:34\ttabs.txt');
  assert.equal(f.fileName, 'tabs.txt');
  assert.equal(f.size, 1234);
});

test('listingStr regenerates a line the parser accepts again', () => {
  const f = parse('-rw-r--r--   1 martin users        1234 Jun 15 12:34 hello.txt');
  const again = parse(f.listingStr);
  assert.equal(again.fileName, 'hello.txt');
  assert.equal(again.size, 1234);
  assert.equal(again.owner.name, 'martin');
  assert.equal(again.rights.text, 'rw-r--r--');
});

// ---------------------------------------------------------------------------
// TRemoteFile — behaviour
// ---------------------------------------------------------------------------

test('the . and .. predicates, and hidden files', () => {
  const parent = new R.TRemoteParentDirectory({ userName: 'u' });
  assert.equal(parent.isParentDirectory, true);
  assert.equal(parent.isThisDirectory, false);
  assert.equal(parent.isDirectory, true);
  assert.equal(parent.modificationFmt, R.MODIFICATION_FMT.NONE);

  const dot = new R.TRemoteDirectoryFile();
  dot.fileName = '.';
  assert.equal(dot.isThisDirectory, true);

  const hidden = new R.TRemoteFile();
  hidden.fileName = '.bashrc';
  assert.equal(hidden.isHidden, true);
  // An explicit setting overrides the name-based guess in both directions.
  hidden.isHidden = false;
  assert.equal(hidden.isHidden, false);
  const shown = new R.TRemoteFile();
  shown.fileName = 'normal';
  assert.equal(shown.isHidden, false);
  shown.isHidden = true;
  assert.equal(shown.isHidden, true);
});

test('a symlink to a directory IS a directory', () => {
  const link = new R.TRemoteFile();
  link.type = 'l';
  link.fileName = 'link';
  link.linkTo = '/tmp';
  assert.equal(link.isSymLink, true);
  // Unresolved, the type character alone says "not a directory".
  assert.equal(link.isDirectory, false);

  const target = new R.TRemoteFile();
  target.type = 'd';
  target.fileName = 'tmp';
  link.linkedFile = target;
  assert.equal(link.isDirectory, true);
  assert.equal(link.resolve(), target);
});

test('symlink resolution reports a broken link rather than throwing', () => {
  const terminal = { userName: 'martin', resolvingSymlinks: true };
  const link = new R.TRemoteFile();
  link.terminal = terminal;
  link.type = 'l';
  link.fileName = 'dangling';
  link.linkTo = '/nowhere';

  const errors = [];
  link.complete(() => { throw new Error('No such file'); }, (e) => errors.push(e));
  assert.equal(link.linkedFile, null);
  assert.equal(errors.length, 1);
  assert.equal(link.brokenLink, true);

  // With symlink resolution off, nothing is followed and nothing looks broken.
  link.terminal = { userName: 'martin', resolvingSymlinks: false };
  assert.equal(link.brokenLink, false);
});

test('a malformed symlink resolver result is refused as a broken link', () => {
  const link = new R.TRemoteFile();
  link.terminal = { resolvingSymlinks: true };
  link.type = 'l';
  link.fileName = 'bad-link';
  link.linkTo = '/target';
  const errors = [];
  link.complete(() => ({ type: 'dir' }), (error) => errors.push(error));
  assert.equal(link.linkedFile, null);
  assert.equal(link.brokenLink, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /invalid remote file/);
});

test('a symlink loop is detected and marks the whole chain', () => {
  const terminal = { userName: 'martin', resolvingSymlinks: true };
  const first = new R.TRemoteFile();
  first.terminal = terminal;
  first.type = 'l';
  first.fileName = 'a';
  first.linkTo = '/loop';

  // The resolver hands back another link with the SAME target — a cycle.
  let resolverCalls = 0;
  const resolver = (file) => {
    resolverCalls++;
    const next = new R.TRemoteFile(file);
    next.terminal = terminal;
    next.type = 'l';
    next.fileName = 'b';
    next.linkTo = '/loop';
    return next;
  };

  first.complete(resolver);
  assert.equal(resolverCalls, 1);
  const second = first.linkedFile;
  assert.equal(second.fileName, 'b');
  assert.equal(second.cyclicLink, false);

  // Following the second link finds an ancestor with the same target.
  second.findLinkedFile(resolver);
  assert.equal(second.cyclicLink, true);
  assert.equal(second.linkedFile, null);
  // The whole chain is marked, so nothing tries again.
  assert.equal(first.cyclicLink, true);
  assert.equal(first.brokenLink, true);
  assert.equal(resolverCalls, 1, 'a cycle must not call the server again');
});

test('symlink cycles are detected across relative and absolute target spellings', () => {
  const terminal = { userName: 'martin', resolvingSymlinks: true };
  const directory = { fullDirectory: '/home/links/' };
  const first = new R.TRemoteFile();
  first.terminal = terminal;
  first.directory = directory;
  first.type = 'l';
  first.fileName = 'a';
  first.linkTo = '../shared';

  let resolverCalls = 0;
  first.complete(() => {
    resolverCalls++;
    const next = new R.TRemoteFile(first);
    next.terminal = terminal;
    next.directory = directory;
    next.type = 'l';
    next.fileName = 'b';
    next.linkTo = '/home/shared';
    return next;
  });

  const second = first.linkedFile;
  second.findLinkedFile(() => {
    resolverCalls++;
    return new R.TRemoteFile(second);
  });
  assert.equal(resolverCalls, 1, 'equivalent targets must not be resolved again');
  assert.equal(second.cyclicLink, true);
  assert.equal(first.brokenLink, true);
});

test('resolve() terminates even on a self-referential chain', () => {
  const a = new R.TRemoteFile();
  a.fileName = 'a';
  a.linkedFile = a;
  assert.equal(a.resolve(), a);
});

test('an inaccessible directory is one the logged-in user cannot enter', () => {
  const make = (rights, owner, group) => {
    const f = new R.TRemoteFile();
    f.type = 'd';
    f.fileName = 'd';
    f.rights.octal = rights;
    f.owner.name = owner;
    f.group.name = group;
    return f;
  };

  const asMartin = { userName: 'martin', membership: ['users'] };
  const worldExec = make('755', 'root', 'root');
  worldExec.terminal = asMartin;
  assert.equal(worldExec.isInaccessibleDirectory, false);

  const noExec = make('750', 'root', 'root');
  noExec.terminal = asMartin;
  assert.equal(noExec.isInaccessibleDirectory, true);

  // Group execute plus membership is enough.
  const groupExec = make('750', 'root', 'users');
  groupExec.terminal = asMartin;
  assert.equal(groupExec.isInaccessibleDirectory, false);

  // Owner execute plus ownership is enough, even with the @host suffix.
  const ownerExec = make('700', 'martin@host', 'root');
  ownerExec.terminal = asMartin;
  assert.equal(ownerExec.isInaccessibleDirectory, false);

  // Root may enter anything.
  const asRoot = { userName: 'root', membership: [] };
  const closed = make('700', 'someone', 'someone');
  closed.terminal = asRoot;
  assert.equal(closed.isInaccessibleDirectory, false);

  // A plain file is never "inaccessible directory".
  const file = make('600', 'root', 'root');
  file.type = '-';
  file.terminal = asMartin;
  assert.equal(file.isInaccessibleDirectory, false);

  // The three bits are not tested alike, and the asymmetry is the original's.
  // An UNDEFINED "other execute" counts as possibly-executable...
  const undefOther = make('750', 'root', 'root');
  undefOther.terminal = asMartin;
  undefOther.rights.allowUndef = true;
  undefOther.rights.setRightUndef(R.RIGHT.OtherExec, R.RIGHT_STATE.Undef);
  assert.equal(undefOther.isInaccessibleDirectory, false);

  // ...but an undefined GROUP execute does not, because that branch reads the
  // boolean Right[] accessor, which is true only for an explicitly set bit.
  const undefGroup = make('700', 'root', 'users');
  undefGroup.terminal = asMartin;
  undefGroup.rights.allowUndef = true;
  undefGroup.rights.setRightUndef(R.RIGHT.OtherExec, R.RIGHT_STATE.No);
  undefGroup.rights.setRightUndef(R.RIGHT.GroupExec, R.RIGHT_STATE.Undef);
  assert.equal(undefGroup.isInaccessibleDirectory, true);
});

test('a dot-file reports itself as its own extension when sorting by Ext', () => {
  const f = new R.TRemoteFile();
  f.fileName = '.bashrc';
  assert.equal(f.extension, '.bashrc');
  assert.equal(f.iconType, 'ext:bashrc');

  const plain = new R.TRemoteFile();
  plain.fileName = 'README';
  assert.equal(plain.extension, '');
  assert.equal(plain.iconType, 'file');
});

test('setting a modification implies full precision', () => {
  const f = parse('-rw-r--r-- 1 u g 5 Jun 15 12:34 x');
  assert.equal(f.modificationFmt, R.MODIFICATION_FMT.MDHM);
  f.setModification(f.modification + 1000);
  assert.equal(f.modificationFmt, R.MODIFICATION_FMT.FULL);
});

test('encryption removes the header overhead from the reported size', () => {
  const f = new R.TRemoteFile();
  f.size = 1000;
  f.setEncrypted(64);
  assert.equal(f.isEncrypted, true);
  assert.equal(f.size, 936);
  // A file smaller than the overhead is left alone rather than going negative.
  const tiny = new R.TRemoteFile();
  tiny.size = 10;
  tiny.setEncrypted(64);
  assert.equal(tiny.size, 10);
});

test('duplicate copies everything, including a resolved link', () => {
  const f = parse('lrwxrwxrwx 1 martin users 7 Jun 15 12:34 link -> /etc/hosts');
  const target = new R.TRemoteFile();
  target.type = 'd';
  target.fileName = 'hosts';
  f.linkedFile = target;
  f.tags = 'a=b';

  const copy = f.duplicate(true);
  assert.equal(copy.fileName, 'link');
  assert.equal(copy.linkTo, '/etc/hosts');
  assert.equal(copy.tags, 'a=b');
  assert.equal(copy.owner.name, 'martin');
  assert.equal(copy.rights.text, f.rights.text);
  assert.equal(copy.linkedFile.fileName, 'hosts');
  assert.equal(copy.linkedFile.linkedByFile, copy);
  // The copy is independent.
  copy.owner.name = 'other';
  assert.equal(f.owner.name, 'martin');
});

test('a file names itself through its directory, or through a stored full name', () => {
  const list = new R.TRemoteFileList();
  list.directory = '/home/martin';
  const file = parse('-rw-r--r-- 1 u g 5 Jun 15 12:34 a.txt');
  list.addFile(file);
  assert.equal(file.haveFullFileName, true);
  assert.equal(file.fullFileName, '/home/martin/a.txt');

  const dir = parse('drwxr-xr-x 2 u g 5 Jun 15 12:34 sub');
  list.addFile(dir);
  // A directory's full name carries the trailing slash.
  assert.equal(dir.fullFileName, '/home/martin/sub/');

  const parent = new R.TRemoteParentDirectory();
  list.addFile(parent);
  assert.equal(parent.fullFileName, '/home/');

  const standalone = new R.TRemoteFile();
  assert.equal(standalone.haveFullFileName, false);
  standalone.fullFileName = '/elsewhere/x';
  assert.equal(standalone.fullFileName, '/elsewhere/x');
});

test('iconType classifies without a shell, and strips a partial suffix', () => {
  const f = parse('-rw-r--r-- 1 u g 5 Jun 15 12:34 report.pdf.filepart');
  assert.equal(f.isPartial, true);
  assert.equal(f.partial, true);
  assert.equal(f.iconType, 'ext:pdf');
  const numbered = parse('-rw-r--r-- 1 u g 5 Jun 15 12:34 report.pdf.FILEPART.2');
  assert.equal(numbered.partial, true);
  const ordinary = parse('-rw-r--r-- 1 u g 5 Jun 15 12:34 report.filepartx');
  assert.equal(ordinary.partial, false);
  const d = parse('drwxr-xr-x 2 u g 5 Jun 15 12:34 sub');
  assert.equal(d.iconType, 'dir');
  assert.equal(new R.TRemoteParentDirectory().iconType, 'parent');
});

test('directory-view aliases expose symlink state without changing the canonical field', () => {
  const link = parse('lrwxrwxrwx 1 u g 7 Jun 15 12:34 current -> release');
  assert.equal(link.isSymLink, true);
  assert.equal(link.isSymlink, true);
  link.type = '-';
  assert.equal(link.isSymLink, false);
  assert.equal(link.isSymlink, false);
});

// ---------------------------------------------------------------------------
// TRemoteFileList / TRemoteDirectory
// ---------------------------------------------------------------------------

function fileNamed(name, isDir, size, mtime) {
  const f = new R.TRemoteFile();
  f.type = isDir ? 'd' : '-';
  f.fileName = name;
  f.size = size || 0;
  f.modification = mtime || 0;
  return f;
}

test('a file list normalizes its directory and reports the parent path', () => {
  const list = new R.TRemoteFileList();
  list.directory = '/home/martin/';
  assert.equal(list.directory, '/home/martin');
  assert.equal(list.fullDirectory, '/home/martin/');
  assert.equal(list.parentPath, '/home/');
  assert.equal(list.isRoot, false);
  list.directory = '/';
  assert.equal(list.isRoot, true);
  assert.equal(list.parentPath, '/');
});

test('total size counts files only, because directories report zero', () => {
  const list = new R.TRemoteFileList();
  list.addFile(fileNamed('a', false, 100));
  list.addFile(fileNamed('b', false, 200));
  list.addFile(fileNamed('d', true, 4096));
  assert.equal(list.totalSize, 300);
  assert.equal(list.count, 3);
  assert.equal(list.findFile('b').size, 200);
  assert.equal(list.findFile('missing'), null);
});

test('extractFile removes without destroying', () => {
  const list = new R.TRemoteFileList();
  const f = fileNamed('a', false, 1);
  list.addFile(f);
  assert.equal(f.directory, list);
  list.extractFile(f);
  assert.equal(list.count, 0);
  assert.equal(f.directory, null);
  assert.equal(f.fileName, 'a');
});

test('duplicateTo copies the files, the directory and the timestamp', () => {
  const list = new R.TRemoteFileList();
  list.directory = '/x';
  list.addFile(fileNamed('a', false, 1));
  const copy = new R.TRemoteFileList();
  list.duplicateTo(copy);
  assert.equal(copy.directory, '/x');
  assert.equal(copy.timestamp, list.timestamp);
  assert.equal(copy.count, 1);
  assert.notEqual(copy.files[0], list.files[0]);
  assert.equal(copy.files[0].directory, copy);
});

test('the panel sort keeps .. first and directories above files', () => {
  const list = new R.TRemoteFileList();
  const parent = new R.TRemoteParentDirectory();
  list.addFile(fileNamed('zeta.txt', false, 10));
  list.addFile(fileNamed('alpha.txt', false, 30));
  list.addFile(fileNamed('sub', true));
  list.addFile(parent);

  list.sort({ sortColumn: R.SORT_COLUMN.Name, sortAscending: true });
  assert.deepEqual(list.files.map((f) => f.fileName), ['..', 'sub', 'alpha.txt', 'zeta.txt']);

  // Descending flips the names but NOT the parent/directory grouping.
  list.sort({ sortColumn: R.SORT_COLUMN.Name, sortAscending: false });
  assert.deepEqual(list.files.map((f) => f.fileName), ['..', 'sub', 'zeta.txt', 'alpha.txt']);
});

test('every sort column falls back to the name, so the order is total', () => {
  const list = new R.TRemoteFileList();
  list.addFile(fileNamed('b.txt', false, 100, 2000));
  list.addFile(fileNamed('a.txt', false, 100, 1000));
  list.addFile(fileNamed('c.log', false, 50, 3000));

  list.sort({ sortColumn: R.SORT_COLUMN.Size, sortAscending: true });
  assert.deepEqual(list.files.map((f) => f.fileName), ['c.log', 'a.txt', 'b.txt']);

  list.sort({ sortColumn: R.SORT_COLUMN.Changed, sortAscending: true });
  assert.deepEqual(list.files.map((f) => f.fileName), ['a.txt', 'b.txt', 'c.log']);

  list.sort({ sortColumn: R.SORT_COLUMN.Ext, sortAscending: true });
  assert.deepEqual(list.files.map((f) => f.fileName), ['c.log', 'a.txt', 'b.txt']);
});

test('natural order sorts file10 after file2', () => {
  const list = new R.TRemoteFileList();
  list.addFile(fileNamed('file10.txt', false));
  list.addFile(fileNamed('file2.txt', false));
  list.sort({ sortColumn: R.SORT_COLUMN.Name, sortAscending: true, naturalOrderNumericalSorting: true });
  assert.deepEqual(list.files.map((f) => f.fileName), ['file2.txt', 'file10.txt']);
  list.sort({ sortColumn: R.SORT_COLUMN.Name, sortAscending: true, naturalOrderNumericalSorting: false });
  assert.deepEqual(list.files.map((f) => f.fileName), ['file10.txt', 'file2.txt']);
});

test('a calculated directory size takes over from the reported one when sorting', () => {
  const small = fileNamed('small', true);
  const big = fileNamed('big', true);
  small.calculatedSize = 10;
  big.calculatedSize = 1000;
  const list = new R.TRemoteFileList();
  list.addFile(big);
  list.addFile(small);
  list.sort({ sortColumn: R.SORT_COLUMN.Size, sortAscending: true });
  assert.deepEqual(list.files.map((f) => f.fileName), ['small', 'big']);
});

test('a directory drops the . entry and can hide the .. entry', () => {
  const terminal = { userName: 'martin', active: true, resolvingSymlinks: false };
  const dir = new R.TRemoteDirectory(terminal);
  dir.directory = '/home/martin';

  const thisDir = fileNamed('.', true);
  assert.equal(dir.addFile(thisDir), false, '"." is never listed');
  assert.equal(dir.count, 0);

  const parent = new R.TRemoteParentDirectory();
  assert.equal(dir.addFile(parent), true);
  dir.addFile(fileNamed('a.txt', false, 1));
  assert.equal(dir.count, 2);
  assert.equal(dir.loaded, true);

  // Hiding the parent removes it from the list but keeps it available.
  dir.includeParentDirectory = false;
  assert.equal(dir.count, 1);
  assert.equal(dir.parentDirectory, parent);
  dir.includeParentDirectory = true;
  assert.equal(dir.count, 2);

  // A copy of a list with a hidden parent still gets the parent entry.
  dir.includeParentDirectory = false;
  const copy = new R.TRemoteFileList();
  dir.duplicateTo(copy);
  assert.equal(copy.count, 2);
  assert.equal(copy.files.some((f) => f.isParentDirectory), true);

  // A new directory inherits the preference from a template.
  const next = new R.TRemoteDirectory(terminal, dir);
  assert.equal(next.includeParentDirectory, false);
  assert.equal(next.loaded, false, 'an unread directory is not loaded');
});

test('a list rejects malformed objects and duplicate names', () => {
  const list = new R.TRemoteFileList();
  const first = fileNamed('same.txt', false, 1);
  assert.equal(list.addFile(first), true);
  assert.equal(list.addFile({ fileName: 'bad.txt' }), false);
  assert.equal(list.addFile(fileNamed('same.txt', false, 2)), false);
  assert.equal(list.count, 1);
});

test('reset detaches old entries and forgets a hidden parent', () => {
  const dir = new R.TRemoteDirectory({ userName: 'martin', active: true });
  dir.directory = '/home/martin';
  const parent = new R.TRemoteParentDirectory();
  const child = fileNamed('child.txt', false, 1);
  dir.addFile(parent);
  dir.addFile(child);
  dir.includeParentDirectory = false;
  dir.reset();
  assert.equal(dir.count, 0);
  assert.equal(dir.parentDirectory, null);
  assert.equal(parent.directory, null);
  assert.equal(child.directory, null);
  assert.equal(child.haveFullFileName, false);

  // A fresh parent can now be added without the old hidden entry reappearing.
  dir.includeParentDirectory = true;
  const freshParent = new R.TRemoteParentDirectory();
  dir.addFile(freshParent);
  assert.equal(dir.parentDirectory, freshParent);
  assert.equal(dir.count, 1);
});

test('files added to a directory inherit its terminal', () => {
  const terminal = { userName: 'martin', active: true, resolvingSymlinks: true };
  const dir = new R.TRemoteDirectory(terminal);
  const f = fileNamed('a', false, 1);
  dir.addFile(f);
  assert.equal(f.terminal, terminal);
});

// ---------------------------------------------------------------------------
// caches
// ---------------------------------------------------------------------------

test('the directory cache keys on the path without its trailing slash', () => {
  const cache = new R.TRemoteDirectoryCache();
  assert.equal(cache.isEmpty, true);

  const list = new R.TRemoteFileList();
  list.directory = '/home/martin';
  list.addFile(fileNamed('a.txt', false, 1));
  cache.addFileList(list);

  assert.equal(cache.isEmpty, false);
  assert.equal(cache.hasFileList('/home/martin'), true);
  assert.equal(cache.hasFileList('/home/martin/'), true);
  assert.equal(cache.hasFileList('/home'), false);

  const out = new R.TRemoteFileList();
  assert.equal(cache.getFileList('/home/martin/', out), true);
  assert.equal(out.count, 1);
  // The caller gets a copy, so mutating it cannot corrupt the cache.
  out.addFile(fileNamed('b.txt', false, 1));
  const again = new R.TRemoteFileList();
  cache.getFileList('/home/martin', again);
  assert.equal(again.count, 1);

  assert.equal(cache.getFileList('/nowhere', new R.TRemoteFileList()), false);
});

test('clearing a cached directory optionally takes its subdirectories', () => {
  const cache = new R.TRemoteDirectoryCache();
  for (const dir of ['/a', '/a/b', '/a/b/c', '/ab']) {
    const list = new R.TRemoteFileList();
    list.directory = dir;
    cache.addFileList(list);
  }
  cache.clearFileList('/a', false);
  assert.equal(cache.hasFileList('/a'), false);
  assert.equal(cache.hasFileList('/a/b'), true);

  cache.clearFileList('/a', true);
  assert.equal(cache.hasFileList('/a/b'), false);
  assert.equal(cache.hasFileList('/a/b/c'), false);
  // '/ab' is not a child of '/a' despite the prefix.
  assert.equal(cache.hasFileList('/ab'), true);

  cache.clear();
  assert.equal(cache.isEmpty, true);
});

test('hasNewerFileList compares against the read timestamp', () => {
  const cache = new R.TRemoteDirectoryCache();
  const list = new R.TRemoteFileList();
  list.directory = '/x';
  list.timestamp = 1000;
  cache.addFileList(list);
  assert.equal(cache.hasNewerFileList('/x', 500), true);
  assert.equal(cache.hasNewerFileList('/x', 1000), false);
  assert.equal(cache.hasNewerFileList('/x', 2000), false);
  assert.equal(cache.hasNewerFileList('/other', 0), false);
});

test('the changes cache remembers where a symlink cd actually landed', () => {
  const cache = new R.TRemoteDirectoryChangesCache(100);
  assert.equal(cache.isEmpty, true);

  // 'cd www' from /home/martin really landed in /var/www.
  cache.addDirectoryChange('/home/martin', 'www', '/var/www');
  assert.deepEqual(cache.getDirectoryChange('/home/martin', 'www'),
    { ok: true, targetDir: '/var/www' });

  // A change that resolves to itself stores only the destination marker.
  cache.addDirectoryChange('/home/martin', 'docs', '/home/martin/docs');
  assert.deepEqual(cache.getDirectoryChange('/home/martin', 'docs'),
    { ok: true, targetDir: '/home/martin/docs' });

  assert.equal(cache.getDirectoryChange('/home/martin', 'unknown').ok, false);

  // Deleting the symlink forgets the mapping.
  cache.clearDirectoryChangeTarget('/var/www');
  assert.equal(cache.getDirectoryChange('/home/martin', 'www').ok, false);
});

test('the changes cache serializes with its version marker and its cap', () => {
  const cache = new R.TRemoteDirectoryChangesCache(2);
  cache.addDirectoryChange('/a', 'x', '/1');
  cache.addDirectoryChange('/b', 'y', '/2');
  cache.addDirectoryChange('/c', 'z', '/3');
  const data = cache.serialize();
  assert.equal(data[0], 'A');
  // Only the most recent entries survive the cap.
  assert.equal(data.split('\n').filter((l) => l).length, 2);

  const restored = new R.TRemoteDirectoryChangesCache(2);
  restored.deserialize(data);
  assert.equal(restored.isEmpty, false);
  const other = new R.TRemoteDirectoryChangesCache(2);
  other.deserialize('');
  assert.equal(other.isEmpty, true);
});

test('clearDirectoryChange drops every entry under a source directory', () => {
  const cache = new R.TRemoteDirectoryChangesCache(100);
  cache.addDirectoryChange('/home', 'a', '/1');
  cache.addDirectoryChange('/home', 'b', '/2');
  cache.addDirectoryChange('/other', 'c', '/3');
  cache.clearDirectoryChange('/home');
  assert.equal(cache.getDirectoryChange('/home', 'a').ok, false);
  assert.equal(cache.getDirectoryChange('/home', 'b').ok, false);
  assert.equal(cache.getDirectoryChange('/other', 'c').ok, true);
});

test('a directory change key needs either a source or an absolute change', () => {
  const key = R.TRemoteDirectoryChangesCache.directoryChangeKey;
  assert.deepEqual(key('/a', 'b'), { ok: true, key: '/a,b' });
  assert.deepEqual(key('', '/b'), { ok: true, key: '/b' });
  assert.equal(key('', 'b').ok, false);
  assert.equal(key('/a', '').ok, false);
});

// ---------------------------------------------------------------------------
// TRemoteProperties
// ---------------------------------------------------------------------------

function propsFile(rights, owner, group, tags) {
  const f = new R.TRemoteFile();
  f.type = '-';
  f.fileName = 'f';
  f.rights.octal = rights;
  f.owner.name = owner;
  f.group.name = group;
  f.tags = tags || '';
  return f;
}

test('common properties of a single file are just that file', () => {
  const common = R.TRemoteProperties.commonProperties([propsFile('644', 'martin', 'users', 't')]);
  assert.equal(common.valid.has(R.VALID_PROPERTY.Rights), true);
  assert.equal(common.valid.has(R.VALID_PROPERTY.Owner), true);
  assert.equal(common.valid.has(R.VALID_PROPERTY.Group), true);
  assert.equal(common.rights.octal, '0644');
  assert.equal(common.rights.allowUndef, false);
  assert.equal(common.owner.name, 'martin');
  assert.equal(common.tags, 't');
});

test('common properties of a mixed selection go undefined, field by field', () => {
  const common = R.TRemoteProperties.commonProperties([
    propsFile('644', 'martin', 'users', 'a'),
    propsFile('664', 'martin', 'staff', 'b'),
  ]);
  // The owner agrees, so it stays.
  assert.equal(common.valid.has(R.VALID_PROPERTY.Owner), true);
  assert.equal(common.owner.name, 'martin');
  // The group does not, so it drops out of `valid` and is never sent. The
  // NAME survives, because TRemoteToken::Clear only clears the numeric id —
  // the dialog blanks the field from `valid`, not from the token.
  assert.equal(common.valid.has(R.VALID_PROPERTY.Group), false);
  assert.equal(common.group.name, 'users');
  assert.equal(common.group.idValid, false);
  assert.equal(common.valid.has(R.VALID_PROPERTY.Tags), false);
  // The permissions keep the bits they agree on and grey out the rest.
  assert.equal(common.rights.allowUndef, true);
  assert.equal(common.rights.getRightUndef(R.RIGHT.GroupWrite), R.RIGHT_STATE.Undef);
  assert.equal(common.rights.getRightUndef(R.RIGHT.UserRead), R.RIGHT_STATE.Yes);
});

test('a file whose rights the server never sent contributes none', () => {
  const unknown = new R.TRemoteFile();
  unknown.fileName = 'x';
  unknown.owner.name = 'martin';
  assert.equal(unknown.rights.unknown, true);
  const common = R.TRemoteProperties.commonProperties([unknown]);
  assert.equal(common.valid.has(R.VALID_PROPERTY.Rights), false);
  assert.equal(common.valid.has(R.VALID_PROPERTY.Owner), true);
  // A group that was never set is not offered either.
  assert.equal(common.valid.has(R.VALID_PROPERTY.Group), false);
});

test('changedProperties sends only what the user actually altered', () => {
  const original = R.TRemoteProperties.commonProperties([propsFile('644', 'martin', 'users', 't')]);

  const untouched = new R.TRemoteProperties(original);
  const nothing = R.TRemoteProperties.changedProperties(original, untouched);
  assert.equal(nothing.valid.has(R.VALID_PROPERTY.Rights), false);
  assert.equal(nothing.valid.has(R.VALID_PROPERTY.Owner), false);
  assert.equal(nothing.valid.has(R.VALID_PROPERTY.Group), false);
  assert.equal(nothing.valid.has(R.VALID_PROPERTY.Tags), false);

  const changed = new R.TRemoteProperties(original);
  changed.rights.octal = '755';
  const some = R.TRemoteProperties.changedProperties(original, changed);
  assert.equal(some.valid.has(R.VALID_PROPERTY.Rights), true);
  assert.equal(some.valid.has(R.VALID_PROPERTY.Owner), false);

  // "Add x to directories" forces the rights through even when they match.
  const addX = new R.TRemoteProperties(original);
  addX.addXToDirectories = true;
  assert.equal(
    R.TRemoteProperties.changedProperties(original, addX).valid.has(R.VALID_PROPERTY.Rights),
    true);

  // A recursive change sends everything, because the children were not read.
  const recursive = new R.TRemoteProperties(original);
  recursive.recursive = true;
  const all = R.TRemoteProperties.changedProperties(original, recursive);
  assert.equal(all.valid.has(R.VALID_PROPERTY.Rights), true);
  assert.equal(all.valid.has(R.VALID_PROPERTY.Owner), true);
});

test('properties equality only looks at the fields marked valid', () => {
  const a = new R.TRemoteProperties();
  const b = new R.TRemoteProperties();
  assert.equal(a.equals(b), true);
  // An owner nobody marked valid may differ without making them unequal.
  a.owner.name = 'martin';
  assert.equal(a.equals(b), true);
  a.valid.add(R.VALID_PROPERTY.Owner);
  assert.equal(a.equals(b), false);
  b.valid.add(R.VALID_PROPERTY.Owner);
  assert.equal(a.equals(b), false);
  b.owner.name = 'martin';
  assert.equal(a.equals(b), true);
  // Recursion is part of the identity of a change.
  b.recursive = true;
  assert.equal(a.equals(b), false);
});

// ---------------------------------------------------------------------------
// TSynchronizeChecklist
// ---------------------------------------------------------------------------

function checklistItem(action, localName, remoteName, opts) {
  const o = opts || {};
  const item = new R.TSynchronizeChecklistItem();
  item.action = action;
  item.isDirectory = !!o.isDirectory;
  item.info1.fileName = localName;
  item.info1.directory = o.localDir === undefined ? 'C:' + BS + 'work' : o.localDir;
  item.info1.size = o.localSize || 0;
  item.info2.fileName = remoteName;
  item.info2.directory = o.remoteDir === undefined ? '/srv/work' : o.remoteDir;
  item.info2.size = o.remoteSize || 0;
  return item;
}

test('reversing an action mirrors it, and new is not the same as update', () => {
  const A = R.SYNC_ACTION;
  assert.equal(R.reverseSyncAction(A.UploadNew), A.DeleteLocal);
  assert.equal(R.reverseSyncAction(A.DownloadNew), A.DeleteRemote);
  assert.equal(R.reverseSyncAction(A.UploadUpdate), A.DownloadUpdate);
  assert.equal(R.reverseSyncAction(A.DownloadUpdate), A.UploadUpdate);
  assert.equal(R.reverseSyncAction(A.DeleteRemote), A.DownloadNew);
  assert.equal(R.reverseSyncAction(A.DeleteLocal), A.UploadNew);
  assert.equal(R.reverseSyncAction(A.None), A.None);
  // Reversing twice is not always the identity, and that is correct: the
  // opposite of "delete the local copy" is "upload it", whose opposite is
  // "delete the local copy" again.
  assert.equal(R.reverseSyncAction(R.reverseSyncAction(A.UploadNew)), A.UploadNew);
});

test('a size only counts when the action actually moves bytes', () => {
  const A = R.SYNC_ACTION;
  const upload = checklistItem(A.UploadNew, 'a.txt', '', { localSize: 100, remoteSize: 999 });
  assert.equal(upload.getSize(), 100);
  assert.equal(upload.isLocalOnly(), true);
  assert.equal(upload.isRemoteOnly(), false);

  const download = checklistItem(A.DownloadUpdate, 'a.txt', 'a.txt', { localSize: 100, remoteSize: 200 });
  assert.equal(download.getSize(), 200);

  // Deleting moves nothing, so it contributes no bytes to the total.
  const del = checklistItem(A.DeleteRemote, '', 'a.txt', { remoteSize: 200 });
  assert.equal(R.isItemSizeIrrelevant(A.DeleteRemote), true);
  assert.equal(del.getSize(), 0);
  assert.equal(del.getBaseSize(), 200);   // the underlying size is still known
  assert.equal(del.isRemoteOnly(), true);
});

test('a directory has no size until something walks it', () => {
  const list = new R.TSynchronizeChecklist();
  const dir = list.add(checklistItem(R.SYNC_ACTION.DownloadNew, '', 'sub', { isDirectory: true }));
  assert.equal(dir.hasSize(), false);
  list.updateDirectorySize(dir, 4096);
  assert.equal(dir.hasSize(), true);
  assert.equal(dir.info2.size, 4096);
  // The side written to follows the direction of the action.
  const localDir = list.add(
    checklistItem(R.SYNC_ACTION.UploadNew, 'sub', '', { isDirectory: true }));
  list.updateDirectorySize(localDir, 8192);
  assert.equal(localDir.info1.size, 8192);
});

test('a checklist row names itself from whichever side has a name', () => {
  const A = R.SYNC_ACTION;
  const remoteOnly = checklistItem(A.DownloadNew, '', 'only-remote.txt');
  assert.equal(remoteOnly.getFileName(), 'only-remote.txt');
  assert.equal(remoteOnly.getRemotePath(), '/srv/work/only-remote.txt');
  // The local path of a remote-only row is empty until forced.
  assert.equal(remoteOnly.getLocalPath(), 'C:' + BS + 'work');
  assert.equal(remoteOnly.forceGetLocalPath(), 'C:' + BS + 'work' + BS + 'only-remote.txt');

  const localOnly = checklistItem(A.UploadNew, 'only-local.txt', '');
  assert.equal(localOnly.getFileName(), 'only-local.txt');
  assert.equal(localOnly.forceGetRemotePath(), '/srv/work/only-local.txt');
  assert.equal(localOnly.getLocalTarget(), 'C:' + BS + 'work' + BS);
  assert.equal(localOnly.getRemoteTarget(), '/srv/work/');
});

test('the checklist sorts by directory then name, and counts what is checked', () => {
  const A = R.SYNC_ACTION;
  const list = new R.TSynchronizeChecklist();
  list.add(checklistItem(A.UploadNew, 'z.txt', '', { localDir: 'C:' + BS + 'b' }));
  list.add(checklistItem(A.UploadNew, 'a.txt', '', { localDir: 'C:' + BS + 'b' }));
  const first = list.add(checklistItem(A.UploadNew, 'm.txt', '', { localDir: 'C:' + BS + 'a' }));
  list.sort();
  assert.deepEqual(list.list.map((i) => i.info1.directory + '|' + i.getFileName()),
    ['C:' + BS + 'a|m.txt', 'C:' + BS + 'b|a.txt', 'C:' + BS + 'b|z.txt']);

  assert.equal(list.checkedCount, 3);
  list.update(first, false, A.None);
  assert.equal(list.checkedCount, 2);
  assert.equal(first.action, A.None);

  // Iterating the checked rows skips the unchecked one.
  const names = [];
  let index = 0;
  for (;;) {
    const next = list.getNextChecked(index);
    if (!next.item) break;
    index = next.index;
    names.push(next.item.getFileName());
  }
  assert.deepEqual(names, ['a.txt', 'z.txt']);

  list.delete(first);
  assert.equal(list.count, 2);
});

test('a remote-only checklist sorts by the remote directory', () => {
  const A = R.SYNC_ACTION;
  const list = new R.TSynchronizeChecklist();
  list.add(checklistItem(A.DownloadNew, '', 'b.txt', { localDir: '', remoteDir: '/z' }));
  list.add(checklistItem(A.DownloadNew, '', 'a.txt', { localDir: '', remoteDir: '/a' }));
  list.sort();
  assert.deepEqual(list.list.map((i) => i.getFileName()), ['a.txt', 'b.txt']);
});

test('progress charges a nominal size for deletions so the bar still moves', () => {
  const A = R.SYNC_ACTION;
  const list = new R.TSynchronizeChecklist();
  list.add(checklistItem(A.DeleteRemote, '', 'a.txt'));
  list.add(checklistItem(A.DeleteRemote, '', 'sub', { isDirectory: true }));
  const progress = new R.TSynchronizeProgress(list);
  // 100 KB for a file, 1 MB for a directory.
  assert.equal(progress.getProcessed(0), 0);
  assert.equal(progress.totalSize, 100 * 1024 + 1024 * 1024);
  progress.itemProcessed(list.item(0));
  assert.equal(progress.progress(0), Math.trunc((100 * 1024 * 100) / (100 * 1024 + 1024 * 1024)));
  // An indeterminate operation reports -1 rather than a made-up number.
  assert.equal(progress.progress(0, true), -1);
});

test('progress counts real bytes for transfers, and estimates the time left', () => {
  const A = R.SYNC_ACTION;
  const list = new R.TSynchronizeChecklist();
  list.add(checklistItem(A.UploadNew, 'a.txt', '', { localSize: 500 }));
  list.add(checklistItem(A.UploadNew, 'b.txt', '', { localSize: 500 }));
  const progress = new R.TSynchronizeProgress(list);
  progress.itemProcessed(list.item(0));
  assert.equal(progress.progress(0), 50);
  assert.equal(progress.progress(250), 75);
  // Half done after ten seconds means about ten seconds remain.
  assert.equal(progress.timeLeft(10000, 0, 0), 10000);
  // Nothing processed yet gives no estimate rather than a division by zero.
  assert.equal(new R.TSynchronizeProgress(list).timeLeft(10000, 0, 0), 0);
});

test('an unchecked row is excluded from the total', () => {
  const A = R.SYNC_ACTION;
  const list = new R.TSynchronizeChecklist();
  const skipped = list.add(checklistItem(A.UploadNew, 'a.txt', '', { localSize: 500 }));
  list.add(checklistItem(A.UploadNew, 'b.txt', '', { localSize: 500 }));
  list.update(skipped, false, A.UploadNew);
  const progress = new R.TSynchronizeProgress(list);
  progress.getProcessed(0);
  assert.equal(progress.totalSize, 500);
});

test('default() clears everything back to a fresh request', () => {
  const p = new R.TRemoteProperties();
  p.valid.add(R.VALID_PROPERTY.Rights);
  p.recursive = true;
  p.tags = 'x';
  p.default();
  assert.equal(p.valid.size, 0);
  assert.equal(p.recursive, false);
  assert.equal(p.tags, '');
  assert.equal(p.rights.number, 0);
  assert.equal(p.owner.isSet, false);
});
