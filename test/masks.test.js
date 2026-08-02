// masks.test.js — the WinSCP mask table.
//
// Every row here is a documented WinSCP behaviour; the awkward ones ('*.*'
// matching extension-less names, '*.' matching only those, '>2019' being a
// SIZE and not a year) are the reason this file is a table rather than prose.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const M = require('../design/main/masks');

/** Fixed clock so relative-time masks are deterministic. */
const NOW = new Date(2020, 5, 15, 12, 0, 0, 0).getTime(); // 2020-06-15 12:00 local
const DAY = 86400000;
const HOUR = 3600000;

function m(mask, name, params) {
  const parsed = M.parse(mask, { now: NOW });
  return M.matches(name, { now: NOW, ...(params || {}) }, parsed);
}

test('name wildcards', () => {
  const rows = [
    // [mask, name, expected]
    ['*.txt', 'a.txt', true],
    ['*.txt', 'a.txt.bak', false],
    ['*.txt', 'a.TXT', true],              // masks are case-insensitive
    ['*.TXT', 'a.txt', true],
    ['a*.txt; b?.doc', 'abc.txt', true],
    ['a*.txt; b?.doc', 'b1.doc', true],
    ['a*.txt; b?.doc', 'b12.doc', false],
    ['a*.txt, b?.doc', 'b1.doc', true],    // ',' is a delimiter too
    ['?.txt', 'a.txt', true],
    ['?.txt', 'ab.txt', false],
    ['[abc]*.log', 'boot.log', true],
    ['[abc]*.log', 'zoot.log', false],
    ['[a-c]*.log', 'catalog.log', true],
    ['[!a-c]*.log', 'catalog.log', false],
    ['[!a-c]*.log', 'zoot.log', true],
    ['readme', 'readme', true],
    ['readme', 'readme.txt', false],
  ];
  for (const [mask, name, want] of rows) {
    assert.strictEqual(m(mask, name), want, `${mask} vs ${name}`);
  }
});

test('the "any" masks and the no-extension mask', () => {
  // '', '*' and '*.*' are all the "any" mask — including for names with no dot.
  for (const any of ['', '*', '*.*']) {
    assert.strictEqual(m(any, 'noextension'), true, `${any} vs noextension`);
    assert.strictEqual(m(any, 'a.txt'), true, `${any} vs a.txt`);
  }
  // '*.' is the opposite: only names WITHOUT an extension.
  assert.strictEqual(m('*.', 'noextension'), true);
  assert.strictEqual(m('*.', 'a.txt'), false);
  assert.strictEqual(m('*.', 'Makefile'), true);
});

test('exclude section after |', () => {
  assert.strictEqual(m('*.txt | secret*', 'a.txt'), true);
  assert.strictEqual(m('*.txt | secret*', 'secret.txt'), false);
  // an exclude-only mask lets everything else through
  assert.strictEqual(m('| *.bak', 'a.txt'), true);
  assert.strictEqual(m('| *.bak', 'a.bak'), false);
  // a second '|' is a syntax error
  assert.strictEqual(M.validate('*.txt | a | b').ok, false);
});

test('leading - excludes a single mask', () => {
  assert.strictEqual(m('*.txt; -secret.txt', 'a.txt'), true);
  assert.strictEqual(m('*.txt; -secret.txt', 'secret.txt'), false);
  // and it works on its own, with no include list at all
  assert.strictEqual(m('-*.bak', 'a.txt'), true);
  assert.strictEqual(m('-*.bak', 'a.bak'), false);
  // a literal leading dash still reachable through a character set
  assert.strictEqual(m('[-]lead.txt', '-lead.txt'), true);
});

test('doubled delimiters are literal', () => {
  assert.strictEqual(m('a;;b.txt', 'a;b.txt'), true);
  assert.strictEqual(m('a;;b.txt', 'a.txt'), false);
});

test('directory masks', () => {
  const parsed = M.parse('logs/', { now: NOW });
  // A directory mask only ever tests directories.
  assert.strictEqual(M.matches('logs', { isDir: true }, parsed), true);
  assert.strictEqual(M.matches('other', { isDir: true }, parsed), false);
  // With no FILE include masks, every file implicitly matches.
  assert.strictEqual(M.matches('a.txt', { isDir: false }, parsed), true);

  // Conversely a plain file mask leaves directories implicitly included, which
  // is what lets '*.txt' still recurse rather than prune every subdirectory.
  const files = M.parse('*.txt', { now: NOW });
  assert.strictEqual(M.matches('subdir', { isDir: true }, files), true);
  assert.strictEqual(M.matches('a.log', { isDir: false }, files), false);
});

test('excluding a whole directory subtree', () => {
  const parsed = M.parse('| node_modules/', { now: NOW });
  assert.strictEqual(M.matches('node_modules', { isDir: true, path: '/p/node_modules' }, parsed), false);
  assert.strictEqual(M.matches('src', { isDir: true, path: '/p/src' }, parsed), true);
  // Exclude masks do NOT walk up the path (MatchesMasks is called with
  // Recurse = false for excludes). The subtree is pruned because the walker
  // never descends into a directory it was told to exclude, not because every
  // descendant tests as excluded.
  assert.strictEqual(
    M.matches('deep', { isDir: true, path: '/p/node_modules/pkg/deep' }, parsed), true);
});

test('include masks DO walk up the path for directories', () => {
  // This is the asymmetric half: a nested directory is included because one of
  // its ancestors matched an include directory mask.
  const parsed = M.parse('wanted/', { now: NOW });
  assert.strictEqual(M.matches('wanted', { isDir: true, path: '/p/wanted' }, parsed), true);
  assert.strictEqual(M.matches('deep', { isDir: true, path: '/p/wanted/deep' }, parsed), true);
  assert.strictEqual(M.matches('other', { isDir: true, path: '/p/other' }, parsed), false);
});

test('path masks', () => {
  const parsed = M.parse('docs/*.txt', { now: NOW });
  assert.strictEqual(M.matches('a.txt', { path: '/docs/a.txt' }, parsed), false); // dir is '/docs'
  assert.strictEqual(M.matches('a.txt', { path: 'docs/a.txt' }, parsed), true);
  assert.strictEqual(M.matches('a.txt', { path: 'other/a.txt' }, parsed), false);
  assert.strictEqual(M.matches('a.txt', {}, parsed), false);                      // no path at all

  const abs = M.parse('/var/log/*.log', { now: NOW });
  assert.strictEqual(M.matches('sys.log', { path: '/var/log/sys.log' }, abs), true);
  assert.strictEqual(M.matches('sys.log', { path: '/var/tmp/sys.log' }, abs), false);

  // backslashes are normalized to '/'
  const win = M.parse('docs\\*.txt', { now: NOW });
  assert.strictEqual(M.matches('a.txt', { path: 'docs/a.txt' }, win), true);
});

test('relative ./ path masks resolve against a root', () => {
  const parsed = M.parse('./sub/*.txt', { now: NOW, root: '/home/me' });
  assert.strictEqual(M.matches('a.txt', { path: '/home/me/sub/a.txt' }, parsed), true);
  assert.strictEqual(M.matches('a.txt', { path: '/home/other/sub/a.txt' }, parsed), false);
});

test('size masks', () => {
  const rows = [
    ['>1M', 2 * 1024 * 1024, true],
    ['>1M', 1024 * 1024, false],          // '>' is exclusive
    ['>=1M', 1024 * 1024, true],
    ['<=500K', 500 * 1024, true],
    ['<500K', 500 * 1024, false],
    ['<500K', 499 * 1024, true],
    ['>1K<10K', 5 * 1024, true],
    ['>1K<10K', 50 * 1024, false],
    ['>1K<10K', 512, false],
    ['>2019', 3000, true],                // a plain integer is BYTES, not a year
    ['>2019', 1000, false],
    ['>1G', 2 * 1024 * 1024 * 1024, true],
  ];
  for (const [mask, size, want] of rows) {
    assert.strictEqual(m(mask, 'anything.bin', { size, mtime: NOW }), want, `${mask} vs ${size}`);
  }
  // combined with a name
  assert.strictEqual(m('*.bin>1M', 'a.bin', { size: 2e6, mtime: NOW }), true);
  assert.strictEqual(m('*.bin>1M', 'a.txt', { size: 2e6, mtime: NOW }), false);
  // no size supplied -> a size mask cannot match
  assert.strictEqual(m('>1M', 'a.bin', {}), false);
});

test('size unit parsing', () => {
  assert.strictEqual(M.tryStrToSize('10'), 10);
  assert.strictEqual(M.tryStrToSize('10K'), 10240);
  assert.strictEqual(M.tryStrToSize('10k'), 10240);
  assert.strictEqual(M.tryStrToSize('1M'), 1048576);
  assert.strictEqual(M.tryStrToSize('1G'), 1073741824);
  assert.strictEqual(M.tryStrToSize('1T'), null);   // no terabyte unit in WinSCP
  assert.strictEqual(M.tryStrToSize('abc'), null);
});

test('absolute time masks', () => {
  const jan2019 = new Date(2019, 0, 1, 0, 0, 0).getTime();
  const jun2019 = new Date(2019, 5, 1, 0, 0, 0).getTime();
  assert.strictEqual(m('>2019-01-01', 'a', { size: 1, mtime: jun2019 }), true);
  assert.strictEqual(m('>2019-01-01', 'a', { size: 1, mtime: jan2019 - 1 }), false);
  assert.strictEqual(m('>=2019-01-01', 'a', { size: 1, mtime: jan2019 }), true);
  assert.strictEqual(m('>2019-01-01', 'a', { size: 1, mtime: jan2019 }), false);
  assert.strictEqual(m('<2019-01-01', 'a', { size: 1, mtime: jan2019 - 1 }), true);
  // a range
  assert.strictEqual(m('>2019-01-01<2019-12-31', 'a', { size: 1, mtime: jun2019 }), true);
  assert.strictEqual(m('>2019-01-01<2019-12-31', 'a', { size: 1, mtime: NOW }), false);
  // with a time of day
  assert.strictEqual(
    m('>2019-06-01 12:00:00', 'a', { size: 1, mtime: new Date(2019, 5, 1, 13).getTime() }), true);
  assert.strictEqual(
    m('>2019-06-01 12:00:00', 'a', { size: 1, mtime: new Date(2019, 5, 1, 11).getTime() }), false);
  // no timestamp supplied -> cannot match
  assert.strictEqual(m('>2019-01-01', 'a', {}), false);
});

test('relative time masks', () => {
  // '>30D' means "newer than 30 days ago"
  assert.strictEqual(m('>30D', 'a', { size: 1, mtime: NOW - 10 * DAY }), true);
  assert.strictEqual(m('>30D', 'a', { size: 1, mtime: NOW - 40 * DAY }), false);
  assert.strictEqual(m('<30D', 'a', { size: 1, mtime: NOW - 40 * DAY }), true);
  assert.strictEqual(m('>2H', 'a', { size: 1, mtime: NOW - HOUR }), true);
  assert.strictEqual(m('>2H', 'a', { size: 1, mtime: NOW - 3 * HOUR }), false);
  assert.strictEqual(m('>1Y', 'a', { size: 1, mtime: NOW - 100 * DAY }), true);
  assert.strictEqual(m('>1Y', 'a', { size: 1, mtime: NOW - 400 * DAY }), false);

  // 'today' is '0DS': from the start of today, not 24 hours ago
  const startOfToday = new Date(2020, 5, 15, 0, 0, 0, 0).getTime();
  assert.strictEqual(m('>today', 'a', { size: 1, mtime: startOfToday + 60000 }), true);
  assert.strictEqual(m('>today', 'a', { size: 1, mtime: startOfToday - 60000 }), false);
  assert.strictEqual(m('>yesterday', 'a', { size: 1, mtime: startOfToday - 60000 }), true);
  assert.strictEqual(m('>yesterday', 'a', { size: 1, mtime: startOfToday - DAY - 60000 }), false);
});

test('relative time is resolved at match time, not parse time', () => {
  // A saved transfer preset must keep meaning "the last day" forever.
  const parsed = M.parse('>1D', { now: NOW });
  const later = NOW + 10 * DAY;
  assert.strictEqual(M.matches('a', { size: 1, mtime: NOW, now: NOW }, parsed), true);
  assert.strictEqual(M.matches('a', { size: 1, mtime: NOW, now: later }, parsed), false);
  assert.strictEqual(M.matches('a', { size: 1, mtime: later, now: later }, parsed), true);
});

test('size and time bounds combined with an exclude list', () => {
  const parsed = M.parse('*.log>1K | *.log>10M', { now: NOW });
  const p = (size) => ({ size, mtime: NOW, now: NOW });
  assert.strictEqual(M.matches('a.log', p(5 * 1024), parsed), true);
  assert.strictEqual(M.matches('a.log', p(100), parsed), false);          // below the include bound
  assert.strictEqual(M.matches('a.log', p(50 * 1024 * 1024), parsed), false); // excluded
});

test('maskToRegex', () => {
  assert.ok(M.maskToRegex('*.txt').test('a.txt'));
  assert.ok(!M.maskToRegex('*.txt').test('a.doc'));
  assert.ok(M.maskToRegex('a?c').test('abc'));
  assert.ok(M.maskToRegex('[0-9]*').test('1file'));
  assert.ok(!M.maskToRegex('[0-9]*').test('file'));
  assert.ok(M.maskToRegex('a.b').test('a.b'));
  assert.ok(!M.maskToRegex('a.b').test('axb'), 'the dot must be literal');
  assert.ok(!M.maskToRegex('*.txt', { caseSensitive: true }).test('A.TXT'));
  assert.ok(M.maskToRegex('*.txt', { caseSensitive: true }).test('a.txt'));
  assert.throws(() => M.maskToRegex('[abc'), M.MaskError);
});

test('validate reports human-readable errors with a position', () => {
  assert.deepStrictEqual(M.validate('*.txt'), { ok: true });
  assert.deepStrictEqual(M.validate(''), { ok: true });
  assert.deepStrictEqual(M.validate('*.txt | *.bak'), { ok: true });

  const dup = M.validate('*.txt | *.bak | *.tmp');
  assert.strictEqual(dup.ok, false);
  assert.match(dup.error, /only appear once/);

  const badSize = M.validate('*.txt>1X');
  assert.strictEqual(badSize.ok, false);
  assert.match(badSize.error, /not a size/);
  assert.ok(badSize.length > 0);

  const badSet = M.validate('[abc*.txt');
  assert.strictEqual(badSet.ok, false);
  assert.match(badSet.error, /Unterminated character set/);

  const twoLow = M.validate('*.txt>1M>2M');
  assert.strictEqual(twoLow.ok, false);
  assert.match(twoLow.error, /Duplicate lower size bound/);

  const dirWithSize = M.validate('logs/>1M');
  assert.strictEqual(dirWithSize.ok, false);
  assert.match(dirWithSize.error, /directory mask cannot carry/);
});

test('matchesEx distinguishes explicit from implicit matches', () => {
  const parsed = M.parse('*.txt', { now: NOW });
  assert.deepStrictEqual(M.matchesEx('a.txt', {}, parsed), { matched: true, implicit: false });
  assert.deepStrictEqual(M.matchesEx('d', { isDir: true }, parsed), { matched: true, implicit: true });
});

test('FileMask caches the parse and short-circuits an empty mask', () => {
  const fm = new M.FileMask('');
  assert.strictEqual(fm.empty, true);
  assert.strictEqual(fm.matches('anything', { isDir: true }), true);

  const fm2 = new M.FileMask('*.txt');
  assert.strictEqual(fm2.empty, false);
  assert.strictEqual(fm2.matches('a.txt'), true);
  assert.strictEqual(fm2.matches('a.doc'), false);
});

test('the default asciiFileMask from defaults.js parses and behaves', () => {
  const { COPY_PARAM_DEFAULTS } = require('../design/main/defaults');
  const fm = new M.FileMask(COPY_PARAM_DEFAULTS.asciiFileMask);
  assert.strictEqual(fm.matches('index.html'), true);
  assert.strictEqual(fm.matches('notes.txt'), true);
  assert.strictEqual(fm.matches('app.js'), true);
  assert.strictEqual(fm.matches('.htaccess'), true);
  assert.strictEqual(fm.matches('photo.jpg'), false);
  assert.strictEqual(fm.matches('archive.zip'), false);
});

test('isMask', () => {
  assert.strictEqual(M.isMask('*.txt'), true);
  assert.strictEqual(M.isMask('a?b'), true);
  assert.strictEqual(M.isMask('[ab]'), true);
  assert.strictEqual(M.isMask('plain.txt'), false);
});
