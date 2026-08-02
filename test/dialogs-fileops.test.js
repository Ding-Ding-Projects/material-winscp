// dialogs-fileops.test.js — the pure logic behind the file-operation dialogs.
//
// The renderer is ES modules and the test runner is CommonJS, so each module is
// pulled in with a dynamic import. That is deliberate rather than a workaround:
// these modules are written so that everything worth testing — the permission
// model, the mask grammar, the multi-selection aggregate — is free of the DOM,
// and importing them here proves it stays that way.
//
// Three things are pinned down:
//
//   1. TRights, both directions. Octal to text and text back to octal, with
//      setuid/setgid/sticky in their combined ('s', 't') and extended
//      ('S', 'T') forms, undefined bits, and the errors WinSCP words itself.
//   2. The mask validator, message for message and position for position
//      against design/main/masks.js. The renderer has its own copy so it can
//      underline the offending run while the user types; this test is what
//      stops the two drifting apart.
//   3. The properties aggregate over a multi-file selection: counts, sizes,
//      the intersected permissions, and the owner/group that only survive
//      while every file agrees.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const masks = require('../design/main/masks');

const DIALOGS = path.join(__dirname, '..', 'design', 'renderer', 'ui', 'dialogs');
const load = (name) => import(pathToFileURL(path.join(DIALOGS, `${name}.js`)).href);

/* ================================================================== */
/* 1. permissions                                                      */
/* ================================================================== */

test('octal to symbolic, including setuid, setgid and the sticky bit', async () => {
  const R = await load('rights');
  const rows = [
    ['0000', '---------'],
    ['0644', 'rw-r--r--'],
    ['0755', 'rwxr-xr-x'],
    ['0777', 'rwxrwxrwx'],
    ['4755', 'rwsr-xr-x'],       // setuid with execute
    ['2755', 'rwxr-sr-x'],       // setgid with execute
    ['1777', 'rwxrwxrwt'],       // sticky with execute
    ['4644', 'rwSr--r--'],       // setuid WITHOUT execute
    ['2644', 'rw-r-Sr--'],       // setgid without execute
    ['1644', 'rw-r--r-T'],       // sticky without execute
    ['7777', 'rwsrwsrwt'],
    ['7000', '--S--S--T'],
    ['0421', 'r---w---x'],
  ];
  for (const [octal, text] of rows) {
    assert.strictEqual(R.textOf(R.fromOctal(octal)), text, `${octal} -> text`);
  }
});

test('symbolic to octal, in both notations', async () => {
  const R = await load('rights');
  const rows = [
    ['---------', '0000'],
    ['rw-r--r--', '0644'],
    ['rwxr-xr-x', '0755'],
    ['rwsr-xr-x', '4755'],
    ['rwxr-sr-x', '2755'],
    ['rwxrwxrwt', '1777'],
    ['rwSr--r--', '4644'],
    ['rw-r-Sr--', '2644'],
    ['rw-r--r-T', '1644'],
    ['rwsrwsrwt', '7777'],
    ['--S--S--T', '7000'],
  ];
  for (const [text, octal] of rows) {
    assert.strictEqual(R.octalOf(R.fromText(text)), octal, `${text} -> octal`);
  }
});

test('every mode round-trips through text and back', async () => {
  const R = await load('rights');
  for (let n = 0; n <= 0o7777; n += 1) {
    const rights = R.fromNumber(n);
    const text = R.textOf(rights);
    assert.strictEqual(text.length, 9, `mode ${n.toString(8)} produced ${text}`);
    assert.strictEqual(R.numberSet(R.fromText(text)), n, `mode ${n.toString(8)} did not survive the round trip`);
  }
});

test('a three-digit octal is accepted and normalized to four', async () => {
  const R = await load('rights');
  assert.strictEqual(R.octalOf(R.fromOctal('644')), '0644');
  assert.strictEqual(R.octalOf(R.fromOctal('0644')), '0644');
  assert.strictEqual(R.octalOf(R.parseRights('755')), '0755');
  assert.strictEqual(R.octalOf(R.parseRights('rwxr-xr-x')), '0755');
});

test('malformed permissions are refused with WinSCP’s own wording', async () => {
  const R = await load('rights');
  assert.throws(() => R.fromOctal('89'), /'89' is not valid permission in octal format\./);
  assert.throws(() => R.fromOctal('7778'), /'7778' is not valid permission in octal format\./);
  assert.throws(() => R.fromOctal(''), /is not valid permission in octal format\./);
  assert.throws(() => R.fromText('rw-r--r'), /Invalid rights description 'rw-r--r'/);
  assert.throws(() => R.fromText('rw- r--r-'), /Invalid rights description/);
  // '$' is an undefined bit and is only legal where undefined bits are.
  assert.throws(() => R.fromText('rw$r--r--'), /Invalid rights description/);
  assert.doesNotThrow(() => R.fromText('rw$r--r--', { allowUndef: true }));
});

test('undefined bits survive text, and produce a chmod mode string', async () => {
  const R = await load('rights');
  const undef = R.allUndef();
  assert.ok(R.isUndef(undef));
  assert.strictEqual(R.textOf(undef), '$$$$$$$$$');
  assert.strictEqual(R.modeStrOf(undef), '');

  const partial = R.withState(R.fromOctal('0644'), 'userExec', 'undef');
  assert.ok(R.isUndef(partial));
  assert.strictEqual(R.textOf(partial), 'rw$r--r--');
  // Only the bits that are decided appear in the chmod string.
  assert.strictEqual(R.modeStrOf(partial), 'u+rw-s,g+r-wxs,o+r-wxt');
  assert.strictEqual(R.chmodStrOf(partial, false), R.modeStrOf(partial));
  // A decided mode is octal, and a directory gets the leading fifth zero.
  assert.strictEqual(R.chmodStrOf(R.fromOctal('0755'), false), '0755');
  assert.strictEqual(R.chmodStrOf(R.fromOctal('0755'), true), '00755');
});

test('state changes are immutable and cover all three states', async () => {
  const R = await load('rights');
  const base = R.fromOctal('0644');
  const next = R.withState(base, 'otherWrite', 'yes');
  assert.strictEqual(R.octalOf(base), '0644', 'the input was mutated');
  assert.strictEqual(R.octalOf(next), '0646');
  assert.strictEqual(R.stateOf(next, 'otherWrite'), 'yes');
  assert.strictEqual(R.stateOf(base, 'otherWrite'), 'no');
  assert.strictEqual(R.stateOf(R.withState(base, 'otherWrite', 'undef'), 'otherWrite'), 'undef');
});

test('add X to directories only adds where read or write is already set', async () => {
  const R = await load('rights');
  assert.strictEqual(R.octalOf(R.addExecute(R.fromOctal('0644'))), '0755');
  assert.strictEqual(R.octalOf(R.addExecute(R.fromOctal('0600'))), '0700');
  assert.strictEqual(R.octalOf(R.addExecute(R.fromOctal('0000'))), '0000');
  // Once everybody can execute, the option has nothing left to do.
  assert.strictEqual(R.addXEffective(R.fromOctal('0755')), false);
  assert.strictEqual(R.addXEffective(R.fromOctal('0644')), true);
});

test('a group button cycles yes -> no -> undefined -> yes', async () => {
  const R = await load('rights');
  let rights = R.fromOctal('0700');                 // user: rwx
  rights = R.cycleGroup(rights, 'user', true);
  assert.strictEqual(R.textOf(rights).slice(0, 3), '---');
  rights = R.cycleGroup(rights, 'user', true);
  assert.strictEqual(R.textOf(rights).slice(0, 3), '$$$');
  rights = R.cycleGroup(rights, 'user', true);
  assert.strictEqual(R.textOf(rights).slice(0, 3), 'rwx');
  // Without undefined states the cycle is just on/off.
  let plain = R.fromOctal('0700');
  plain = R.cycleGroup(plain, 'user', false);
  assert.strictEqual(R.textOf(plain).slice(0, 3), '---');
  plain = R.cycleGroup(plain, 'user', false);
  assert.strictEqual(R.textOf(plain).slice(0, 3), 'rwx');
  // A row that disagrees with itself jumps straight to "yes".
  const mixed = R.withState(R.fromOctal('0400'), 'userWrite', 'undef');
  assert.strictEqual(R.textOf(R.cycleGroup(mixed, 'user', true)).slice(0, 3), 'rwx');
});

test('intersecting permissions marks the disagreements undefined', async () => {
  const R = await load('rights');
  const both = R.intersect(R.fromOctal('0644'), R.fromOctal('0755'), true);
  assert.strictEqual(R.textOf(both), 'rw$r-$r-$');
  assert.strictEqual(R.numberSet(both), 0o644);
  // Without undefined bits it collapses to a plain AND, as the C++ does.
  assert.strictEqual(R.octalOf(R.intersect(R.fromOctal('0644'), R.fromOctal('0755'), false)), '0644');
  // Identical inputs stay fully decided.
  assert.strictEqual(R.isUndef(R.intersect(R.fromOctal('0644'), R.fromOctal('0644'), true)), false);
});

test('combine applies the other side’s decided bits and stays decided', async () => {
  const R = await load('rights');
  // The bits the other side leaves undefined are the ones this side keeps.
  const adding = R.withState(R.allUndef(), 'otherRead', 'yes');
  assert.strictEqual(R.octalOf(R.combine(R.fromOctal('0600'), adding)), '0604');
  const removing = R.withState(R.allUndef(), 'userWrite', 'no');
  assert.strictEqual(R.octalOf(R.combine(R.fromOctal('0600'), removing)), '0400');
  // A fully decided other side decides everything — that is what the C++ does,
  // because Combine goes through Number, which rewrites both masks.
  assert.strictEqual(R.octalOf(R.combine(R.fromOctal('0600'), R.fromOctal('0044'))), '0044');
  assert.strictEqual(R.isUndef(R.combine(R.fromOctal('0600'), adding)), false);
});

/* ================================================================== */
/* 2. mask validation                                                  */
/* ================================================================== */

/** A fixed clock so relative-time masks are deterministic on both sides. */
const NOW = new Date(2020, 5, 15, 12, 0, 0, 0).getTime();

const MASK_CASES = [
  // valid
  '', '*', '*.*', '*.', '*.txt', 'a*.txt; b?.doc', 'a*.txt, b?.doc', 'docs/*.txt', 'logs/',
  '*.txt>1M<=10M', '*.log>2019-01-01', '*.log>30D', '*.log>today', '*.log<yesterday',
  '-*.bak', 'a | b', '[abc]*.log', '[a-z].txt', '[!a-c]*.log', '[^a]x', 'x;;y.txt',
  '  *.txt  ', 'photo??.png', '*/public_html/*.html', '*.zip>1G; <2012-01-21',
  '*.txt>2019', 'a.txt>=1M', 'a.txt<=1M', 'a.txt>1024',
  // malformed
  '[abc*.log', '[]*.log', 'sub[dir/*.txt', '*.txt>1M>2M', '*.txt<1M<2M', '*.txt>banana',
  'dir/>1M', 'a | b | c', '*.log>2019-02-31', '*.log>25:99',
];

test('the renderer mask validator agrees with design/main/masks.js', async () => {
  const M = await load('editmask');
  for (const mask of MASK_CASES) {
    const mine = M.validateMask(mask, { now: NOW });
    const theirs = masks.validate(mask, { now: NOW });
    assert.strictEqual(mine.ok, theirs.ok, `verdict differs for ${JSON.stringify(mask)}`);
    if (!theirs.ok) {
      assert.strictEqual(mine.error, theirs.error, `message differs for ${JSON.stringify(mask)}`);
      assert.strictEqual(mine.start, theirs.start, `start differs for ${JSON.stringify(mask)}`);
      assert.strictEqual(mine.length, theirs.length, `length differs for ${JSON.stringify(mask)}`);
    }
  }
});

test('a malformed mask says what is wrong and where', async () => {
  const M = await load('editmask');
  const unterminated = M.validateMask('[abc*.log');
  assert.strictEqual(unterminated.ok, false);
  assert.match(unterminated.error, /Unterminated character set "\["/);
  assert.match(unterminated.error, /add the closing "\]"/);
  assert.strictEqual(unterminated.start, 0);
  assert.strictEqual(unterminated.length, 9);

  // '[]' is not an empty set: a ']' straight after '[' is a literal ']', so the
  // set is still open — which is what the engine says, and what this must say.
  const empty = M.validateMask('a[]b');
  assert.strictEqual(empty.ok, false);
  assert.match(empty.error, /Unterminated character set/);
  assert.strictEqual(empty.start, 1);
  assert.deepStrictEqual(
    { error: empty.error, start: empty.start, length: empty.length },
    (({ error, start, length }) => ({ error, start, length }))(masks.validate('a[]b')),
  );

  const twoPipes = M.validateMask('a | b | c');
  assert.strictEqual(twoPipes.ok, false);
  assert.match(twoPipes.error, /can only appear once/);

  const badSize = M.validateMask('*.txt>banana');
  assert.strictEqual(badSize.ok, false);
  assert.match(badSize.error, /is not a size .* nor a date .* nor a relative time/);
  // The offending run is located, not just described.
  assert.strictEqual('*.txt>banana'.slice(badSize.start, badSize.start + badSize.length), 'banana');

  const dirBound = M.validateMask('dir/>1M');
  assert.strictEqual(dirBound.ok, false);
  assert.match(dirBound.error, /A directory mask cannot carry a size or time condition/);

  const duplicate = M.validateMask('*.txt>1M>2M');
  assert.strictEqual(duplicate.ok, false);
  assert.match(duplicate.error, /Duplicate lower size bound ">2M"/);
});

test('a valid mask is sorted into the four buckets the editor shows', async () => {
  const M = await load('editmask');
  const parsed = M.parseMaskString('a.txt; dir/; -*.bak | *.tmp; -junk/');
  assert.deepStrictEqual(parsed.fileInclude, ['a.txt']);
  assert.deepStrictEqual(parsed.dirInclude, ['dir/']);
  assert.deepStrictEqual(parsed.fileExclude, ['*.bak', '*.tmp']);
  assert.deepStrictEqual(parsed.dirExclude, ['junk/']);
});

test('composing the four buckets is the inverse, and escapes delimiters', async () => {
  const M = await load('editmask');
  assert.strictEqual(M.composeMaskStr(['*.txt'], [], [], []), '*.txt');
  assert.strictEqual(M.composeMaskStr(['*.txt'], ['*.bak'], [], []), '*.txt | *.bak');
  assert.strictEqual(M.composeMaskStr(['*.txt'], [], ['docs'], []), '*.txt; docs/');
  assert.strictEqual(M.composeMaskStr([], [], [], ['node_modules']), '| node_modules/');
  // A name that genuinely contains a delimiter survives the round trip.
  assert.strictEqual(M.composeMaskStr(['a;b'], [], [], []), 'a;;b');
  assert.deepStrictEqual(M.parseMaskString('a;;b').fileInclude, ['a;b']);
  // A directory mask keeps its slash rather than gaining a second one.
  assert.strictEqual(M.composeMaskStr([], [], ['docs/'], []), 'docs/');

  const composed = M.composeMaskStr(['*.txt', '*.md'], ['*.bak'], ['src'], ['node_modules']);
  assert.strictEqual(composed, '*.txt; *.md; src/ | *.bak; node_modules/');
  const back = M.parseMaskString(composed);
  assert.deepStrictEqual(back.fileInclude, ['*.txt', '*.md']);
  assert.deepStrictEqual(back.dirInclude, ['src/']);
  assert.deepStrictEqual(back.fileExclude, ['*.bak']);
  assert.deepStrictEqual(back.dirExclude, ['node_modules/']);
});

test('everything the composer emits is a mask the engine accepts', async () => {
  const M = await load('editmask');
  const composed = M.composeMaskStr(['*.txt', 'photo??.png'], ['*.bak', '*.zip>1G'], ['src'], ['node_modules']);
  assert.strictEqual(masks.validate(composed).ok, true, `main rejected ${composed}`);
});

/* ================================================================== */
/* 3. the properties aggregate                                         */
/* ================================================================== */

const FILES = [
  { name: 'a.txt', type: 'file', size: 100, mtime: 1000, rights: 'rw-r--r--', owner: 'root', group: 'staff' },
  { name: 'b.txt', type: 'file', size: 200, mtime: 3000, rights: 'rwxr-xr-x', owner: 'root', group: 'staff' },
  { name: 'sub', type: 'dir', size: 0, mtime: 2000, rights: 'rwxr-xr-x', owner: 'root', group: 'wheel' },
];

test('the aggregate counts what is selected', async () => {
  const P = await load('properties');
  const agg = P.aggregateSelection(FILES);
  assert.strictEqual(agg.count, 3);
  assert.strictEqual(agg.files, 2);
  assert.strictEqual(agg.directories, 1);
  assert.strictEqual(agg.symlinks, 0);
  assert.strictEqual(agg.bytes, 300);
  assert.strictEqual(agg.multiple, true);
  assert.strictEqual(agg.anyDirectories, true);
  assert.strictEqual(agg.mtimeFrom, 1000);
  assert.strictEqual(agg.mtimeTo, 3000);
});

test('a real directory makes the total size unknown until it is calculated', async () => {
  const P = await load('properties');
  assert.strictEqual(P.aggregateSelection(FILES).statsNotCalculated, true);
  assert.strictEqual(P.aggregateSelection(FILES).allowCalculateSize, true);
  // A symlinked directory is never recursed into, so it does not.
  const linked = [{ name: 'link', type: 'dir', size: 0, isSymlink: true, rights: 'rwxr-xr-x' }];
  assert.strictEqual(P.aggregateSelection(linked).statsNotCalculated, false);
  assert.strictEqual(P.aggregateSelection(linked).allowCalculateSize, false);
  // Files only: the size is simply the sum.
  const filesOnly = P.aggregateSelection(FILES.slice(0, 2));
  assert.strictEqual(filesOnly.statsNotCalculated, false);
  assert.strictEqual(filesOnly.bytes, 300);
});

test('permissions intersect across the selection', async () => {
  const P = await load('properties');
  const R = await load('rights');
  const agg = P.aggregateSelection(FILES);
  assert.strictEqual(agg.rightsKnown, true);
  assert.strictEqual(agg.rightsAllowUndef, true);
  // 644 against 755 twice: the execute bits are the disagreement.
  assert.strictEqual(R.textOf(agg.rights), 'rw$r-$r-$');

  // One file: its own permissions, and undefined bits are NOT invited.
  const single = P.aggregateSelection([FILES[0]]);
  assert.strictEqual(R.octalOf(single.rights), '0644');
  assert.strictEqual(single.rightsAllowUndef, false);
  assert.strictEqual(single.multiple, false);
});

test('owner and group survive only while every file agrees', async () => {
  const P = await load('properties');
  const agg = P.aggregateSelection(FILES);
  assert.strictEqual(agg.owner, 'root');
  assert.strictEqual(agg.ownerKnown, true);
  assert.strictEqual(agg.group, null, 'the group differs and must not be claimed');
  assert.strictEqual(agg.groupKnown, false);

  const sameGroup = P.aggregateSelection(FILES.slice(0, 2));
  assert.strictEqual(sameGroup.group, 'staff');
  assert.strictEqual(sameGroup.groupKnown, true);
});

test('a backend that reports no permissions is reported as unknown, not as 000', async () => {
  const P = await load('properties');
  const agg = P.aggregateSelection([
    { name: 'a.txt', type: 'file', size: 1, rights: '', owner: '', group: '' },
    { name: 'b.txt', type: 'file', size: 2, rights: '', owner: '', group: '' },
  ]);
  assert.strictEqual(agg.rightsKnown, false);
  assert.strictEqual(agg.rights, null);
  assert.strictEqual(agg.ownerKnown, false);
  // One file with permissions and one without cannot be intersected honestly.
  const mixed = P.aggregateSelection([FILES[0], { name: 'x', type: 'file', size: 0, rights: '' }]);
  assert.strictEqual(mixed.rightsKnown, false);
  assert.strictEqual(mixed.rights, null);
});

test('a single symlink carries its target, and an empty selection says so', async () => {
  const P = await load('properties');
  const link = P.aggregateSelection([
    { name: 'current', type: 'link', size: 0, isSymlink: true, linkTarget: '/srv/releases/7', rights: 'rwxrwxrwx' },
  ]);
  assert.strictEqual(link.isSymlink, true);
  assert.strictEqual(link.linkTarget, '/srv/releases/7');
  assert.strictEqual(link.symlinks, 1);
  assert.strictEqual(link.name, 'current');

  const none = P.aggregateSelection([]);
  assert.strictEqual(none.count, 0);
  assert.strictEqual(none.rights, null);
  assert.strictEqual(none.name, '');
  assert.strictEqual(P.aggregateSelection(null).count, 0);
});

test('the size cell shows the short form and the exact bytes when they differ', async () => {
  const P = await load('properties');
  assert.strictEqual(P.describeSize(0, true), 'Unknown');
  assert.strictEqual(P.describeSize(512, false), '512 B');       // one form only
  const big = P.describeSize(12884901, false);
  assert.match(big, /^12\.3 MB \(12,884,901 B\)$/);
});

/* ================================================================== */
/* 4. the duplicate dialog's target split                              */
/* ================================================================== */

test('a duplicate target splits into a directory and a file mask', async () => {
  const RT = await load('remotetransfer');
  assert.deepStrictEqual(RT.splitTarget('/tmp/*.bak'), { directory: '/tmp/', mask: '*.bak' });
  assert.deepStrictEqual(RT.splitTarget('/tmp/'), { directory: '/tmp/', mask: '' });
  assert.deepStrictEqual(RT.splitTarget('backup.txt'), { directory: '', mask: 'backup.txt' });
  assert.strictEqual(RT.isFileNameMask('*.bak'), true);
  assert.strictEqual(RT.isFileNameMask(''), true);
  assert.strictEqual(RT.isFileNameMask('one.txt'), false, 'a fixed name would overwrite itself');
});
