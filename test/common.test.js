// common.test.js — core/Common.cpp's utility layer.
//
// The interesting rows here are the ones that look wrong: IsNumber accepting
// '12a', AddQuotes only quoting when there is a space, CutToken treating '""'
// differently depending on which variant you call. Each of those is a real
// WinSCP behaviour something else depends on, so each gets a row.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const C = require('../design/main/common');

// ---------------------------------------------------------------------------
// character classes
// ---------------------------------------------------------------------------

test('character classes are ASCII only', () => {
  assert.equal(C.isLetter('a'), true);
  assert.equal(C.isLetter('Z'), true);
  // Deliberately false: these decide protocol syntax, not human language.
  assert.equal(C.isLetter('\u00e9'), false);
  assert.equal(C.isLetter('4'), false);
  assert.equal(C.isDigit('0'), true);
  assert.equal(C.isDigit('/'), false);
  assert.equal(C.isHex('f'), true);
  assert.equal(C.isHex('F'), true);
  assert.equal(C.isHex('g'), false);
  assert.equal(C.isWideChar('\u00e9'), true);
  assert.equal(C.isWideChar('e'), false);
});

// ---------------------------------------------------------------------------
// string helpers
// ---------------------------------------------------------------------------

test('replaceChar / deleteChar', () => {
  assert.equal(C.replaceChar('a/b/c', '/', '\\'), 'a\\b\\c');
  assert.equal(C.deleteChar('a-b-c', '-'), 'abc');
  assert.equal(C.replaceChar('', 'x', 'y'), '');
});

test('makeValidFileName flattens everything a command line could misread', () => {
  assert.equal(C.makeValidFileName('a b:c/d*e'), 'a-b-c-d-e');
  assert.equal(C.makeValidFileName('plain'), 'plain');
});

test('cutToChar consumes up to the character, and everything when it is absent', () => {
  assert.deepEqual(C.cutToChar('a=b=c', '=', false), { token: 'a', rest: 'b=c' });
  assert.deepEqual(C.cutToChar('abc', '=', false), { token: 'abc', rest: '' });
  // Trim is asymmetric: the token loses trailing space, the rest loses leading.
  assert.deepEqual(C.cutToChar('a  ;   b', ';', true), { token: 'a', rest: 'b' });
  assert.deepEqual(C.cutToChar('', ';', false), { token: '', rest: '' });
});

test('copyToChars reports an index one past the delimiter, even at the end', () => {
  const first = C.copyToChars('a;b;c', 0, ';', false, false);
  assert.deepEqual([first.text, first.from, first.delimiter], ['a', 2, ';']);
  const second = C.copyToChars('a;b;c', first.from, ';', false, false);
  assert.deepEqual([second.text, second.from, second.delimiter], ['b', 4, ';']);
  const third = C.copyToChars('a;b;c', second.from, ';', false, false);
  // No delimiter at the end, but `from` still advances as if there were one.
  assert.deepEqual([third.text, third.from, third.delimiter], ['c', 6, '']);
});

test('copyToChars doubles a delimiter into a literal when asked', () => {
  const r = C.copyToChars('a;;b;c', 0, ';', false, true);
  assert.equal(r.text, 'a;b');
  assert.equal(r.delimiter, ';');
  // Without the escape the same string stops at the first delimiter.
  assert.equal(C.copyToChars('a;;b;c', 0, ';', false, false).text, 'a');
});

test('removeSuffix, with and without the trailing counter', () => {
  assert.equal(C.removeSuffix('report.filepart', '.filepart', false), 'report');
  assert.equal(C.removeSuffix('report.filepart', '.filepart', true), 'report');
  // The digits go too, because the length is taken from the trimmed buffer.
  assert.equal(C.removeSuffix('report.filepart12', '.filepart', true), 'report');
  assert.equal(C.removeSuffix('report.filepart12', '.filepart', false), 'report.filepart12');
  assert.equal(C.removeSuffix('report.txt', '.filepart', false), 'report.txt');
});

test('delimitStr escapes for the quote it is going inside', () => {
  assert.equal(C.delimitStr('a$b', '"'), 'a\\$b');
  assert.equal(C.delimitStr('a"b', '"'), 'a\\"b');
  assert.equal(C.delimitStr('a`b', '"'), 'a\\`b');
  // Inside single quotes nothing is special.
  assert.equal(C.delimitStr('a$b`c"d', "'"), 'a$b`c"d');
  // A leading dash would be read as a switch, so it is defused with './'.
  assert.equal(C.delimitStr('-rf', '"'), './-rf');
  assert.equal(C.shellQuoteStr('my file'), '"my file"');
});

test('addQuotes only quotes when there is a space', () => {
  assert.equal(C.addQuotes('plain'), 'plain');
  assert.equal(C.addQuotes('two words'), '"two words"');
  assert.equal(C.stripPathQuotes('"C:\\a b"'), 'C:\\a b');
  assert.equal(C.stripPathQuotes('C:\\ab'), 'C:\\ab');
  // Strip then re-add, so a quoted path with no space comes back bare.
  assert.equal(C.addPathQuotes('"C:\\ab"'), 'C:\\ab');
  assert.equal(C.addPathQuotes('"C:\\a b"'), '"C:\\a b"');
});

test('isNumber never checks the last character — the ported off-by-one', () => {
  assert.equal(C.isNumber('123'), true);
  assert.equal(C.isNumber('5'), true);
  assert.equal(C.isNumber(''), false);
  assert.equal(C.isNumber('a12'), false);
  // '12a' is accepted, because the loop stops one short.
  assert.equal(C.isNumber('12a'), true);
});

test('trimVersion drops trailing .0 while at least two dots remain', () => {
  assert.equal(C.trimVersion('1.2.0'), '1.2');
  assert.equal(C.trimVersion('1.0.0'), '1.0');
  assert.equal(C.trimVersion('5.21.9'), '5.21.9');
  assert.equal(C.trimVersion('1.0'), '1.0');
  assert.equal(C.formatVersion(5, 21, 0), '5.21');
  assert.equal(C.formatVersion(5, 21, 3), '5.21.3');
});

test('escapeParam doubles quotes; escapePuttyCommandParam follows PuTTY rules', () => {
  assert.equal(C.escapeParam('a"b'), 'a""b');
  assert.equal(C.escapePuttyCommandParam('plain'), 'plain');
  assert.equal(C.escapePuttyCommandParam('a"b'), 'a\\"b');
  // A backslash run before a quote is doubled; one not before a quote is not.
  assert.equal(C.escapePuttyCommandParam('a\\"b'), 'a\\\\\\"b');
  assert.equal(C.escapePuttyCommandParam('a\\b'), 'a\\b');
  assert.equal(C.escapePuttyCommandParam('a b'), '"a b"');
});

test('stripEllipsis and escapeHotkey clean up a menu caption', () => {
  assert.equal(C.stripEllipsis('Save as...'), 'Save as');
  assert.equal(C.stripEllipsis('Save'), 'Save');
  assert.equal(C.escapeHotkey('R&D'), 'R&&D');
});

test('isReservedName knows the Windows device names', () => {
  assert.equal(C.isReservedName('con'), true);
  assert.equal(C.isReservedName('CON.txt'), true);
  assert.equal(C.isReservedName('LPT9'), true);
  assert.equal(C.isReservedName('LPT0'), false);
  assert.equal(C.isReservedName('console'), false);
  assert.equal(C.isReservedName('NUL.tar.gz'), true);
});

test('validLocalFileName substitutes, tokenizes and defuses reserved names', () => {
  assert.equal(C.validLocalFileName('a:b'), 'a_b');
  assert.equal(C.validLocalFileName('a/b\\c'), 'a_b_c');
  // A trailing space or dot would be silently eaten by Windows.
  assert.equal(C.validLocalFileName('name '), 'name_');
  assert.equal(C.validLocalFileName('name.'), 'name_');
  assert.equal(C.validLocalFileName('con.txt'), 'con%00.txt');
  assert.equal(C.validLocalFileName('nul'), 'nul%00');

  // Token mode encodes as '%XX' so the original name can be recovered.
  const tokenizible = C.LOCAL_INVALID_CHARS + C.TOKEN_PREFIX; // what CopyParam uses
  const tokenized = C.validLocalFileName('a<b', C.TOKEN_REPLACEMENT, tokenizible, C.LOCAL_INVALID_CHARS);
  assert.equal(tokenized, 'a%3Cb');
  // Encoding is deliberately NOT idempotent: a '%' that already looks like a
  // token is itself escaped, otherwise decoding could not tell an encoded '<'
  // from a file genuinely named 'a%3Cb'.
  assert.equal(
    C.validLocalFileName(tokenized, C.TOKEN_REPLACEMENT, tokenizible, C.LOCAL_INVALID_CHARS),
    'a%253Cb');
  // A '%' that is not a valid token is left exactly as the user wrote it.
  assert.equal(
    C.validLocalFileName('100% done', C.TOKEN_REPLACEMENT, tokenizible, C.LOCAL_INVALID_CHARS),
    '100% done');

  // No replacement at all: every name Windows cannot store faithfully is refused.
  assert.throws(
    () => C.validLocalFileName('a/b', C.NO_REPLACEMENT, '', C.LOCAL_INVALID_CHARS),
    /not valid filename/);
  for (const name of ['a:b', 'name.', 'name ', 'CON.txt', 'line\u0001break']) {
    assert.throws(
      () => C.validLocalFileName(name, C.NO_REPLACEMENT, '', C.LOCAL_INVALID_CHARS),
      /not valid filename/);
  }
  assert.equal(C.validLocalFileName('safe.txt', C.NO_REPLACEMENT, '', C.LOCAL_INVALID_CHARS), 'safe.txt');
});

// ---------------------------------------------------------------------------
// hex and binary
// ---------------------------------------------------------------------------

test('hex round trips, and refuses malformed input rather than guessing', () => {
  assert.equal(C.byteToHex(0x0a), '0A');
  assert.equal(C.byteToHex(0x0a, false), '0a');
  assert.equal(C.bytesToHex(Buffer.from([1, 2, 255])), '0102FF');
  assert.equal(C.bytesToHex(Buffer.from([1, 2, 255]), true, ':'), '01:02:FF');
  assert.equal(C.charToHex('\u00e9'), '00E9');
  assert.deepEqual(Array.from(C.hexToBytes('0102FF')), [1, 2, 255]);
  assert.equal(C.hexToBytes('0102F').length, 0);   // odd length
  assert.equal(C.hexToBytes('01ZZ').length, 0);    // not hex
  assert.equal(C.hexToByte('ff'), 255);
  assert.equal(C.hexToByte('zz'), 0);
});

test('displayableStr quotes printable bytes and hexes anything else', () => {
  assert.equal(C.displayableStr(Buffer.from('ok')), '"ok"');
  assert.equal(C.displayableStr(Buffer.from('a\r\n\tb')), '"a\\r\\n\\tb"');
  assert.equal(C.displayableStr(Buffer.from('a"b\\c')), '"a\\"b\\\\c"');
  assert.equal(C.displayableStr(Buffer.from([0x00, 0x01])), '0x0001');
  // A high byte is not displayable either — the log must stay ASCII.
  assert.equal(C.displayableStr(Buffer.from([0xff])), '0xFF');
});

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

test('splitCommand handles quoted programs and refuses an unclosed quote', () => {
  assert.deepEqual(C.splitCommand('notepad'), { program: 'notepad', params: '', dir: '' });
  assert.deepEqual(C.splitCommand('notepad a.txt'),
    { program: 'notepad', params: 'a.txt', dir: '' });
  assert.deepEqual(C.splitCommand('"C:\\Program Files\\x\\a.exe" -p 1'),
    { program: 'C:\\Program Files\\x\\a.exe', params: '-p 1', dir: 'C:\\Program Files\\x\\' });
  assert.throws(() => C.splitCommand('"C:\\a b\\x.exe -p'), /Invalid command/);
});

test('extractProgramName strips the path and the extension', () => {
  assert.equal(C.extractProgramName('"C:\\Windows\\notepad.exe" a.txt'), 'notepad');
  assert.equal(C.extractProgramName('vim'), 'vim');
});

test('formatCommand / reformatFileNameCommand keep the !.! placeholder', () => {
  assert.equal(C.formatCommand(' notepad ', ' a.txt '), 'notepad a.txt');
  assert.equal(C.formatCommand('C:\\a b\\x.exe', ''), '"C:\\a b\\x.exe"');
  assert.equal(C.reformatFileNameCommand('notepad'), 'notepad !.!');
  // Already present: not added twice.
  assert.equal(C.reformatFileNameCommand('notepad !.!'), 'notepad !.!');
  assert.equal(C.reformatFileNameCommand(''), '');
  assert.equal(C.expandFileNameCommand('notepad !.!', 'C:\\a b.txt'), 'notepad "C:\\a b.txt"');
});

test('cutToken follows PuTTY quoting; cutTokenEx differs on a bare ""', () => {
  assert.deepEqual(C.splitTokens('a b c'), ['a', 'b', 'c']);
  assert.deepEqual(C.splitTokens('  a\t b  '), ['a', 'b']);
  assert.deepEqual(C.splitTokens('"a b" c'), ['a b', 'c']);
  // A doubled quote is a literal quote for cutToken...
  assert.deepEqual(C.splitTokens('"" x'), ['"', 'x']);
  // ...and the empty string for cutTokenEx, which is how a script passes one.
  assert.deepEqual(C.splitTokens('"" x', true), ['', 'x']);
  // Inside quotes both agree it is a literal quote.
  assert.deepEqual(C.splitTokens('"a""b"', true), ['a"b']);
  assert.equal(C.cutToken('').ok, false);
  assert.equal(C.cutToken('   ').ok, false);

  const one = C.cutToken('  "a b"  rest');
  assert.equal(one.token, 'a b');
  assert.equal(one.rawToken, '  "a b"');
  assert.equal(one.separator, ' ');
  assert.equal(one.rest, ' rest');
});

test('addToList adds a delimiter only where one is missing', () => {
  assert.equal(C.addToList('', 'a', ';'), 'a');
  assert.equal(C.addToList('a', 'b', ';'), 'a;b');
  assert.equal(C.addToList('a;', 'b', ';'), 'a;b');
  // An empty value adds nothing at all, delimiter included.
  assert.equal(C.addToList('a', '', ';'), 'a');
  assert.equal(C.addToShellFileListCommandLine('', 'a b.txt'), '"a b.txt"');
});

test('cutFeature and processFeatures apply a FEAT override', () => {
  assert.deepEqual(C.cutFeature('MLST,MDTM'), { feature: 'MLST', rest: 'MDTM' });
  // A quoted feature may contain the delimiter.
  assert.deepEqual(C.cutFeature('"a,b",c'), { feature: 'a,b', rest: 'c' });
  assert.deepEqual(C.cutFeature('"unterminated'), { feature: 'unterminated', rest: '' });

  assert.deepEqual(C.processFeatures(['MLST', 'MDTM'], '*X,Y'), ['X', 'Y']);
  assert.deepEqual(C.processFeatures(['MLST', 'MDTM'], '-MDTM'), ['MLST']);
  assert.deepEqual(C.processFeatures(['MLST'], '+SIZE'), ['MLST', 'SIZE']);
  assert.deepEqual(C.processFeatures(['MLST'], ''), ['MLST']);
});

// ---------------------------------------------------------------------------
// comparison
// ---------------------------------------------------------------------------

test('compareLogicalText, with and without natural numeric order', () => {
  assert.equal(C.compareLogicalText('a', 'B', false) < 0, true);
  assert.equal(C.compareLogicalText('f10', 'f2', false) < 0, true);
  assert.equal(C.compareLogicalText('f10', 'f2', true) > 0, true);
  assert.equal(C.compareLogicalText('f2', 'f10', true) < 0, true);
  // Equal ignoring case still orders deterministically, so a sort is stable.
  assert.notEqual(C.compareLogicalText('File', 'file', false), 0);
  assert.equal(C.compareLogicalText('same', 'same', false), 0);
  assert.equal(C.compareNumber(1, 2), -1);
  assert.equal(C.compareNumber(2, 2), 0);
  assert.equal(C.compareNumber(3, 2), 1);
});

test('containsTextSemiCaseSensitive: a capital makes the search exact', () => {
  assert.equal(C.containsTextSemiCaseSensitive('Hello World', 'world'), true);
  assert.equal(C.containsTextSemiCaseSensitive('Hello World', 'World'), true);
  assert.equal(C.containsTextSemiCaseSensitive('Hello world', 'World'), false);
});

test('sameIdent ignores case and dashes', () => {
  assert.equal(C.sameIdent('diffie-hellman', 'DiffieHellman'), true);
  assert.equal(C.sameIdent('a', 'b'), false);
  assert.equal(C.findIdent('diffiehellman', ['rsa', 'diffie-hellman']), 'diffie-hellman');
  assert.equal(C.findIdent('nothing', ['rsa']), 'nothing');
});

// ---------------------------------------------------------------------------
// message composition
// ---------------------------------------------------------------------------

test('main instruction tags survive a round trip', () => {
  const tagged = C.mainInstructions('Cannot open');
  assert.equal(tagged, '**Cannot open**');
  const extracted = C.extractMainInstructions(tagged + 'Details here.');
  assert.deepEqual(extracted,
    { found: true, mainInstructions: 'Cannot open', rest: 'Details here.' });
  assert.equal(C.removeMainInstructionsTag(tagged + 'Details.'), 'Cannot openDetails.');
  // Untagged text is returned untouched.
  assert.equal(C.extractMainInstructions('plain').found, false);
  assert.equal(C.removeMainInstructionsTag('plain'), 'plain');
});

test('the first paragraph is highlighted, not the whole message', () => {
  assert.equal(C.hasParagraphs('a\n\nb'), true);
  assert.equal(C.hasParagraphs('a\nb'), false);
  assert.equal(C.mainInstructionsFirstParagraph('a\n\nb'), '**a**\n\nb');
  assert.equal(C.mainInstructionsFirstParagraph('single'), '**single**');
});

test('the interactive part is stripped for display and untagged for reuse', () => {
  const msg = '**Error**Body.$$Press any key$$';
  assert.equal(C.unformatMessage(msg), 'ErrorBody.');
  assert.equal(C.removeInteractiveMsgTag('Body.$$Press any key$$'), 'Body.Press any key');
  assert.equal(C.unformatMessage('plain'), 'plain');
});

test('removeEmptyLines and exceptionLogString', () => {
  assert.equal(C.removeEmptyLines('a\n\nb\n \nc\n\n'), 'a\nb\nc');
  const e = new Error('boom');
  e.name = 'EOSError';
  assert.equal(C.exceptionLogString(e), '(EOSError) boom');
  e.moreMessages = ['more'];
  assert.equal(C.exceptionLogString(e), '(EOSError) boom\nmore');
});

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

test('windows path helpers', () => {
  assert.equal(C.includeTrailingBackslash('C:\\a'), 'C:\\a\\');
  assert.equal(C.includeTrailingBackslash('C:\\a\\'), 'C:\\a\\');
  assert.equal(C.includeTrailingBackslash(''), '');
  assert.equal(C.excludeTrailingBackslash('C:\\a\\'), 'C:\\a');
  assert.equal(C.extractFileName('C:\\a\\b.txt'), 'b.txt');
  assert.equal(C.extractFilePath('C:\\a\\b.txt'), 'C:\\a\\');
  assert.equal(C.extractFileDir('C:\\a\\b.txt'), 'C:\\a');
  assert.equal(C.extractFileDrive('C:\\a'), 'C:');
  assert.equal(C.extractFileDrive('\\\\server\\share\\a'), '\\\\server\\share');
  assert.equal(C.extractFileExt('C:\\a\\b.tar.gz'), '.gz');
  assert.equal(C.extractFileExt('C:\\a\\noext'), '');
  assert.equal(C.extractFileBaseName('C:\\a\\b.txt'), 'b');
  assert.equal(C.changeFileExt('b.txt', '.bak'), 'b.bak');
  assert.equal(C.samePaths('C:\\A', 'c:\\a\\'), true);
  assert.equal(C.isRealFile('.'), false);
  assert.equal(C.isRealFile('..'), false);
  assert.equal(C.isRealFile('...'), true);
});

test('combinePaths never produces a drive-relative path', () => {
  assert.equal(C.combinePaths('C:', 'foo'), 'C:\\foo');
  assert.equal(C.combinePaths('C:\\a', 'b'), 'C:\\a\\b');
  assert.equal(C.combinePaths('C:\\a\\', 'b'), 'C:\\a\\b');
  // An already-absolute second part wins.
  assert.equal(C.combinePaths('C:\\a', 'D:\\b'), 'D:\\b');
  assert.equal(C.getNormalizedPath('C:/a/b/'), 'C:\\a\\b');
  assert.equal(C.fromUnixPath('/a/b'), '\\a\\b');
  assert.equal(C.toUnixPath('\\a\\b'), '/a/b');
});

// ---------------------------------------------------------------------------
// sizes
// ---------------------------------------------------------------------------

test('tryStrToSize accepts K/M/G and nothing else', () => {
  assert.deepEqual(C.tryStrToSize('1024'), { ok: true, size: 1024 });
  assert.deepEqual(C.tryStrToSize('1K'), { ok: true, size: 1024 });
  assert.deepEqual(C.tryStrToSize('1 m'), { ok: true, size: 1048576 });
  assert.deepEqual(C.tryStrToSize('2G'), { ok: true, size: 2 * 1024 * 1024 * 1024 });
  // 'D' is a relative-time unit, so it must not parse as a size.
  assert.equal(C.tryStrToSize('30D').ok, false);
  assert.equal(C.tryStrToSize('KB').ok, false);
  assert.equal(C.tryStrToSize('1KB').ok, false);
  assert.equal(C.tryStrToSize('').ok, false);
});

test('sizeToStr picks the largest unit that loses nothing', () => {
  assert.equal(C.sizeToStr(0), '0');
  assert.equal(C.sizeToStr(1000), '1000');
  assert.equal(C.sizeToStr(1024), '1K');
  assert.equal(C.sizeToStr(1536), '1536');       // not a whole number of K units
  assert.equal(C.sizeToStr(1048576), '1M');
  assert.equal(C.sizeToStr(1073741824), '1G');
  assert.equal(C.sizeToStr(2048), '2K');
});

test('formatSize groups digits and never abbreviates', () => {
  assert.equal(C.formatSize(0), '0');
  assert.equal(C.formatSize(999), '999');
  assert.equal(C.formatSize(1000), '1,000');
  assert.equal(C.formatSize(1234567890), '1,234,567,890');
  assert.equal(C.formatSize(-1234), '-1,234');
  assert.equal(C.formatNumber(1234, ' '), '1 234');
});

test('round breaks a tie towards the floor, unlike Math.round', () => {
  // WinSCP's Round compares the two distances with a strict '>', so an exact
  // half always takes the floor — downwards for positives AND negatives.
  assert.equal(C.round(2.5), 2);
  assert.equal(C.round(-2.5), -3);
  assert.equal(C.round(2.6), 3);
  assert.equal(C.round(2.4), 2);
  assert.equal(Math.round(-2.5), -2); // the difference being guarded against
});

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

test('dst mode accepts the stored integer as well as the name', () => {
  assert.equal(C.normalizeDstMode(0), 'win');
  assert.equal(C.normalizeDstMode(1), 'unix');
  assert.equal(C.normalizeDstMode(2), 'keep');
  assert.equal(C.normalizeDstMode(undefined), 'unix');
});

test('unix mode is the identity; win mode shifts by the DST bias', () => {
  const seconds = Math.floor(Date.UTC(2020, 6, 15, 12, 0, 0) / 1000);
  const ms = seconds * 1000;
  assert.equal(C.unixToDateTime(seconds, 'unix'), ms);
  assert.equal(C.unixToDateTime(seconds, 'keep'), ms);
  const bias = C.dstDifferenceMinutesForTime(ms);
  assert.equal(C.unixToDateTime(seconds, 'win'), ms + bias * 60000);
  // Round trip, whichever mode and whatever this machine's zone.
  assert.equal(C.dateTimeToUnix(C.unixToDateTime(seconds, 'win'), 'win'), seconds);
  assert.equal(C.dateTimeToUnix(C.unixToDateTime(seconds, 'unix'), 'unix'), seconds);
});

test('the DST bias is zero outside DST and matches the zone inside it', () => {
  const params = C.timeZoneParams(2020);
  const jan = new Date(2020, 0, 15, 12).getTime();
  const jul = new Date(2020, 6, 15, 12).getTime();
  if (!params.hasDST) {
    // A zone without DST must report no shift, ever.
    assert.equal(C.isDateInDST(jan), false);
    assert.equal(C.isDateInDST(jul), false);
    assert.equal(C.dstDifferenceMinutesForTime(jan), 0);
    assert.equal(C.dstDifferenceMinutesForTime(jul), 0);
  } else {
    // Exactly one of the two samples is inside DST.
    assert.equal(C.isDateInDST(jan) !== C.isDateInDST(jul), true);
    const inside = C.isDateInDST(jan) ? jan : jul;
    const outside = C.isDateInDST(jan) ? jul : jan;
    assert.equal(C.dstDifferenceMinutesForTime(outside), 0);
    assert.equal(C.dstDifferenceMinutesForTime(inside), params.daylightDifferenceMinutes);
    assert.equal(params.daylightDifferenceMinutes < 0, true);
  }
  assert.equal(C.adjustDateTimeFromUnix(jan, 'unix'), jan);
});

test('formatTimeZone inverts the Windows bias sign', () => {
  assert.equal(C.formatTimeZone(0), '+0');
  assert.equal(C.formatTimeZone(-3600), '+1');       // bias -60 min => GMT+1
  assert.equal(C.formatTimeZone(18000), '-5');       // bias +300 min => GMT-5
  assert.equal(C.formatTimeZone(-19800), '+5:30');   // India
  assert.equal(C.formatTimeZone(-3661), '+1:01:01');
});

test('fixedLenDateTimeFormat doubles single placeholders only', () => {
  assert.equal(C.fixedLenDateTimeFormat('d/m/yy'), 'dd/mm/yy');
  assert.equal(C.fixedLenDateTimeFormat('dd/mm/yyyy'), 'dd/mm/yyyy');
  assert.equal(C.fixedLenDateTimeFormat('h:n:s'), 'hh:nn:ss');
  // am/pm is a marker, not a placeholder to widen.
  assert.equal(C.fixedLenDateTimeFormat('h am/pm'), 'hh am/pm');
  // Quoted text is left exactly as written.
  assert.equal(C.fixedLenDateTimeFormat("'d'd"), "'d'dd");
});

test('standardTimestamp is the ISO shape the XML log writes', () => {
  const ms = Date.UTC(2020, 5, 15, 12, 34, 56, 789);
  assert.equal(C.standardTimestamp(ms), '2020-06-15T12:34:56.789Z');
  assert.equal(C.standardDatestamp(ms), '2020-06-15');
});

test('compareFileTime tolerates FAT two-second granularity', () => {
  const base = Date.UTC(2020, 0, 1, 12, 0, 0);
  assert.equal(C.compareFileTime(base, base), 0);
  assert.equal(C.compareFileTime(base, base + 1999), 0);
  assert.equal(C.compareFileTime(base, base + 2000), -1);
  assert.equal(C.compareFileTime(base + 2000, base), 1);
  assert.equal(C.compareFileTime(base + 1999, base), 0);
});

test('formatDateTimeSpan switches to days past four', () => {
  assert.equal(C.formatDateTimeSpan(0), '0:00:00');
  assert.equal(C.formatDateTimeSpan(3661000), '1:01:01');
  assert.equal(C.formatDateTimeSpan(3 * 86400000 + 3600000), '73:00:00');
  assert.equal(C.formatDateTimeSpan(5 * 86400000), '5 days');
});

test('formatRelativeTime uses Delphi approximate calendar units', () => {
  const now = Date.UTC(2020, 5, 15, 12, 0, 0);
  assert.equal(C.formatRelativeTime(now, now, false), 'just now');
  assert.equal(C.formatRelativeTime(now, now - 1000, false), 'one second ago');
  assert.equal(C.formatRelativeTime(now, now - 5000, false), '5 seconds ago');
  assert.equal(C.formatRelativeTime(now, now - 60000, false), 'one minute ago');
  assert.equal(C.formatRelativeTime(now, now - 3600000, false), 'one hour ago');
  assert.equal(C.formatRelativeTime(now, now - 86400000, false), 'one day ago');
  assert.equal(C.formatRelativeTime(now, now - 3 * 86400000, false), '3 days ago');
  // 31 days is one "month" at 30.4375 days per month.
  assert.equal(C.formatRelativeTime(now, now - 31 * 86400000, false), 'one month ago');
  assert.equal(C.formatRelativeTime(now, now - 400 * 86400000, false), 'one year ago');
  // dateOnly prefers the friendlier wording for the same instants.
  const localNoon = new Date(2020, 5, 15, 12).getTime();
  assert.equal(C.formatRelativeTime(localNoon, localNoon - 3600000, true), 'today');
  assert.equal(C.formatRelativeTime(localNoon, localNoon - 86400000, true), 'yesterday');
});

test('tryRelativeStrToDateTime, including the "start of" suffix', () => {
  const now = new Date(2020, 5, 15, 12, 34, 56, 789).getTime();
  const day = C.tryRelativeStrToDateTime('1D', false, now);
  assert.equal(day.ok, true);
  assert.equal(new Date(day.dateTime).getDate(), 14);
  assert.equal(new Date(day.dateTime).getHours(), 12);

  // 'S' means start-of, so the time is cleared as well.
  const yesterday = C.tryRelativeStrToDateTime('yesterday', false, now);
  assert.equal(yesterday.ok, true);
  assert.equal(new Date(yesterday.dateTime).getDate(), 14);
  assert.equal(new Date(yesterday.dateTime).getHours(), 0);
  assert.equal(new Date(yesterday.dateTime).getMinutes(), 0);

  const today = C.tryRelativeStrToDateTime('today', false, now);
  assert.equal(new Date(today.dateTime).getDate(), 15);
  assert.equal(new Date(today.dateTime).getHours(), 0);

  // Adding rather than subtracting.
  const ahead = C.tryRelativeStrToDateTime('2H', true, now);
  assert.equal(new Date(ahead.dateTime).getHours(), 14);

  // A size unit must not be accepted as a time unit.
  assert.equal(C.tryRelativeStrToDateTime('1K', false, now).ok, false);
  assert.equal(C.tryRelativeStrToDateTime('D', false, now).ok, false);
});

test('tryStrToDateTimeStandard parses the scripting timestamp form', () => {
  const r = C.tryStrToDateTimeStandard('2020-06-15 12:34:56');
  assert.equal(r.ok, true);
  assert.equal(new Date(r.value).getFullYear(), 2020);
  assert.equal(new Date(r.value).getMinutes(), 34);
  assert.equal(C.tryStrToDateTimeStandard('2020-06-15').ok, true);
  assert.equal(C.tryStrToDateTimeStandard('2020-13-01').ok, false);
  assert.equal(C.tryStrToDateTimeStandard('2020-02-31').ok, false);
  assert.equal(C.tryStrToDateTimeStandard('not a date').ok, false);
});

test('parseShortEngMonthName is 1-based and 0 for anything else', () => {
  assert.equal(C.parseShortEngMonthName('Jan'), 1);
  assert.equal(C.parseShortEngMonthName('dec'), 12);
  assert.equal(C.parseShortEngMonthName('Foo'), 0);
});

test('tensOfSecondBetween counts tenths of a second', () => {
  assert.equal(C.tensOfSecondBetween(1000, 0), 10);
  assert.equal(C.tensOfSecondBetween(0, 1050), 10);
});

// ---------------------------------------------------------------------------
// urls
// ---------------------------------------------------------------------------

test('url encoding round trips a non-ASCII name through UTF-8', () => {
  assert.equal(C.encodeUrlString('a b'), 'a%20b');
  assert.equal(C.encodeUrlString('a/b'), 'a%2Fb');
  assert.equal(C.encodeUrlPath('a/b'), 'a/b');
  assert.equal(C.encodeUrlString('h\u00e9'), 'h%C3%A9');
  assert.equal(C.decodeUrlChars('h%C3%A9'), 'h\u00e9');
  assert.equal(C.decodeUrlChars('a+b'), 'a b');
  assert.equal(C.decodeUrlChars('a%2Fb'), 'a/b');
  // A stray percent that is not a valid escape is left alone.
  assert.equal(C.decodeUrlChars('100%'), '100%');
  assert.equal(C.decodeUrlChars(C.encodeUrlString('\u4e00\u4e8c')), '\u4e00\u4e8c');
});

test('appendUrlParams keeps the fragment last', () => {
  assert.equal(C.appendUrlParams('http://x/y', 'a=1'), 'http://x/y?a=1');
  assert.equal(C.appendUrlParams('http://x/y?b=2', 'a=1'), 'http://x/y?b=2&a=1');
  assert.equal(C.appendUrlParams('http://x/y#f', 'a=1'), 'http://x/y?a=1#f');
  assert.equal(C.appendUrlParams('http://x/y#f', ''), 'http://x/y#f');
  assert.equal(C.appendUrlParams('http://x/y', ''), 'http://x/y');
});

test('url predicates', () => {
  assert.equal(C.extractFileNameFromUrl('http://x/a/b.txt?q=1'), 'b.txt');
  assert.equal(C.isHttpUrl('http://x'), true);
  assert.equal(C.isHttpUrl('https://x'), false);
  assert.equal(C.isHttpOrHttpsUrl('https://x'), true);
  assert.equal(C.changeUrlProtocol('http://x/y', 'https'), 'https://x/y');
  assert.equal(C.isDomainOrSubdomain('a.winscp.net', 'winscp.net'), true);
  assert.equal(C.isDomainOrSubdomain('winscp.net', 'winscp.net'), true);
  assert.equal(C.isDomainOrSubdomain('notwinscp.net', 'winscp.net'), false);
});

// ---------------------------------------------------------------------------
// base64 / checksums
// ---------------------------------------------------------------------------

test('base64 helpers and the case rules for checksum comparison', () => {
  assert.equal(C.encodeStrToBase64(Buffer.from('hello')), 'aGVsbG8=');
  assert.equal(C.decodeBase64ToStr('aGVsbG8=').toString(), 'hello');
  assert.equal(C.base64ToUrlSafe('a+b/c='), 'a-b_c');
  assert.equal(C.md5ToUrlSafe('aa:bb:cc'), 'aa-bb-cc');
  // Hex checksums are case-insensitive...
  assert.equal(C.sameChecksum('AA:BB', 'aa-bb', false), true);
  // ...but base64 is not, because case carries information there.
  assert.equal(C.sameChecksum('aGVsbG8=', 'aGVsbG8', true), true);
  assert.equal(C.sameChecksum('aGVsbG8=', 'AGVSBG8', true), false);
});

test('getDividerLine is exactly 27 dashes', () => {
  assert.equal(C.getDividerLine(), '-'.repeat(27));
});
