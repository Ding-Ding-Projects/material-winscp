// protocols-ftp-parse.test.js — the FTP directory listing parser.
//
// LIST output is not standardized, so this is the module most likely to be
// wrong against a server nobody in the team owns. Every sample below is a real
// listing shape from a real server family; none of it is invented.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseListing, detectListingStyle, parseUnixLine, parseDosLine,
  parseVmsRecord, parseMlsdLine, listingSize, rightsToOctal, ftpTimestamp,
} = require('../design/main/protocols/ftp');

// A fixed "now" so the year-less unix dates are deterministic.
const NOW = new Date(2024, 5, 15, 12, 0, 0);

test('detects the listing dialect', () => {
  assert.strictEqual(detectListingStyle('-rw-r--r--   1 root root 1234 Mar  3 09:22 a.txt'), 'unix');
  assert.strictEqual(detectListingStyle('04-27-00  09:09PM       <DIR>          licensed'), 'dos');
  assert.strictEqual(detectListingStyle('type=file;size=12; a.txt'), 'mlsd');
  assert.strictEqual(
    detectListingStyle('DIRECTORY.DIR;1      1/9           2-JUN-2005 07:12 [SYSTEM]  (RWED,RWED,RE,)'),
    'vms',
  );
  assert.strictEqual(detectListingStyle(''), 'unknown');
});

test('unix: files, directories, symlinks and the "total" header', () => {
  const raw = [
    'total 24',
    'drwxr-xr-x    4 root     wheel        4096 Jan 12  2019 folder',
    '-rw-r--r--    1 nobody   nogroup       1234 Mar  3 09:22 report.txt',
    'lrwxrwxrwx    1 root     root            11 Feb  2 15:00 current -> releases/7',
    '-rw-rw-rw-    1 1000     1000       10485760 Dec 31  2021 big file with  spaces.bin',
  ].join('\r\n');

  const items = parseListing(raw, { now: NOW });
  assert.strictEqual(items.length, 4);

  const [dir, file, link, spaced] = items;

  assert.strictEqual(dir.name, 'folder');
  assert.strictEqual(dir.type, 'dir');
  assert.strictEqual(dir.rights, 'rwxr-xr-x');
  assert.strictEqual(dir.owner, 'root');
  assert.strictEqual(dir.group, 'wheel');
  assert.strictEqual(dir.size, 4096);
  assert.strictEqual(new Date(dir.mtime).getFullYear(), 2019);
  assert.strictEqual(new Date(dir.mtime).getMonth(), 0);
  assert.strictEqual(new Date(dir.mtime).getDate(), 12);

  assert.strictEqual(file.name, 'report.txt');
  assert.strictEqual(file.type, 'file');
  assert.strictEqual(file.size, 1234);
  assert.strictEqual(file.rights, 'rw-r--r--');
  // No year in the listing → the most recent March 3rd that is not in the
  // future relative to the reference time.
  assert.strictEqual(new Date(file.mtime).getFullYear(), 2024);
  assert.strictEqual(new Date(file.mtime).getHours(), 9);
  assert.strictEqual(new Date(file.mtime).getMinutes(), 22);

  assert.strictEqual(link.name, 'current');
  assert.strictEqual(link.type, 'link');
  assert.strictEqual(link.isSymlink, true);
  assert.strictEqual(link.linkTarget, 'releases/7');

  // Names keep their internal runs of spaces.
  assert.strictEqual(spaced.name, 'big file with  spaces.bin');
  assert.strictEqual(spaced.size, 10485760);
});

test('unix: a year-less date in the future rolls back a year', () => {
  const line = '-rw-r--r--    1 root root  10 Dec 24 23:59 xmas.txt';
  const e = parseUnixLine(line, new Date(2024, 0, 5, 12, 0, 0));
  assert.strictEqual(new Date(e.mtime).getFullYear(), 2023);
});

test('unix: missing group column, and an owner literally named after a month', () => {
  // Some servers (and every listing produced with `ls -l` under a locale that
  // drops the group) omit the group entirely.
  const noGroup = parseUnixLine('-rw-r--r-- 1 owner 4096 Apr  9 11:00 x.dat', NOW);
  assert.strictEqual(noGroup.name, 'x.dat');
  assert.strictEqual(noGroup.owner, 'owner');
  assert.strictEqual(noGroup.group, '');
  assert.strictEqual(noGroup.size, 4096);

  // 'jan' as a user name must not be mistaken for the month field: the field
  // before a real date is always the size.
  const janUser = parseUnixLine('-rw-r--r-- 1 jan users 512 Aug 20 08:05 notes.md', NOW);
  assert.strictEqual(janUser.name, 'notes.md');
  assert.strictEqual(janUser.owner, 'jan');
  assert.strictEqual(janUser.group, 'users');
  assert.strictEqual(new Date(janUser.mtime).getMonth(), 7);
});

test('unix: numeric ISO dates and ACL-marked permission blocks', () => {
  const e = parseUnixLine('-rw-r--r--+  1 alice staff  99 2020-03-03 09:22 acl.txt', NOW);
  assert.strictEqual(e.name, 'acl.txt');
  assert.strictEqual(e.rights, 'rw-r--r--');
  assert.strictEqual(new Date(e.mtime).getFullYear(), 2020);
  assert.strictEqual(new Date(e.mtime).getMonth(), 2);
  assert.strictEqual(new Date(e.mtime).getDate(), 3);
});

test('unix: setuid/sticky bits and non-regular file types survive', () => {
  const suid = parseUnixLine('-rwsr-xr-x  1 root root 55432 Jan  9  2021 passwd', NOW);
  assert.strictEqual(suid.rights, 'rwsr-xr-x');
  const sock = parseUnixLine('srwxrwxrwx  1 root root     0 Jun  1 10:00 docker.sock', NOW);
  assert.strictEqual(sock.type, 'special');
});

test('DOS/IIS: <DIR> markers, 12-hour clocks and two- and four-digit years', () => {
  const raw = [
    '04-27-00  09:09PM       <DIR>          licensed',
    '07-18-00  10:16AM       <DIR>          pub',
    '02-21-00  10:41PM               45876 README.TXT',
    '12-05-1996  05:03PM              12345 archive with space.zip',
    '01-15-2024  12:00AM                  7 midnight.txt',
  ].join('\r\n');

  const items = parseListing(raw);
  assert.strictEqual(items.length, 5);

  assert.deepStrictEqual(
    items.map((i) => [i.name, i.type, i.size]),
    [
      ['licensed', 'dir', 0],
      ['pub', 'dir', 0],
      ['README.TXT', 'file', 45876],
      ['archive with space.zip', 'file', 12345],
      ['midnight.txt', 'file', 7],
    ],
  );

  const licensed = new Date(items[0].mtime);
  assert.strictEqual(licensed.getFullYear(), 2000);   // 00 pivots forward
  assert.strictEqual(licensed.getMonth(), 3);
  assert.strictEqual(licensed.getDate(), 27);
  assert.strictEqual(licensed.getHours(), 21);        // 09:09PM

  const archive = new Date(items[3].mtime);
  assert.strictEqual(archive.getFullYear(), 1996);
  assert.strictEqual(archive.getHours(), 17);

  // 12:00AM is midnight, not noon — the classic off-by-twelve.
  assert.strictEqual(new Date(items[4].mtime).getHours(), 0);
});

test('DOS: a two-digit year of 96 stays in the twentieth century', () => {
  const e = parseDosLine('11-02-96  10:00AM                 100 old.txt');
  assert.strictEqual(new Date(e.mtime).getFullYear(), 1996);
});

test('VMS: directories, versions, block sizes and wrapped records', () => {
  const raw = [
    'Directory SYS$SYSDEVICE:[ANONYMOUS]',
    '',
    'DIRECTORY.DIR;1      1/9           2-JUN-2005 07:12 [SYSTEM]  (RWED,RWED,RE,)',
    'FILE.TXT;2          18/18          6-MAR-2006 12:34:56 [GROUP,USER] (RWED,RWED,RWED,RE)',
    'CII-MANUAL.TEX;1',
    '                    213/216       29-JAN-1996 03:33:12  [ANONYMOU,ANONYMOUS]   (RWED,RWED,,)',
    '',
    'Total of 3 files, 232/243 blocks.',
  ].join('\r\n');

  const items = parseListing(raw);
  assert.strictEqual(items.length, 3);

  const [dir, file, wrapped] = items;

  assert.strictEqual(dir.name, 'DIRECTORY');      // .DIR;1 identifies a folder
  assert.strictEqual(dir.type, 'dir');
  assert.strictEqual(dir.size, 0);
  assert.strictEqual(new Date(dir.mtime).getFullYear(), 2005);
  assert.strictEqual(new Date(dir.mtime).getMonth(), 5);
  assert.strictEqual(new Date(dir.mtime).getDate(), 2);

  assert.strictEqual(file.name, 'FILE.TXT');
  assert.strictEqual(file.type, 'file');
  assert.strictEqual(file.size, 18 * 512);        // VMS counts 512-byte blocks
  assert.strictEqual(file.owner, 'USER');
  assert.strictEqual(file.group, 'GROUP');
  // VMS protection is (System,Owner,Group,World); we render owner/group/world
  // the way unix does, and D (delete) has no unix equivalent so it is dropped.
  assert.strictEqual(file.rights, 'rwxrwxr-x');
  assert.strictEqual(new Date(file.mtime).getSeconds(), 56);

  // The long name wrapped onto its own line; the record continues underneath.
  assert.strictEqual(wrapped.name, 'CII-MANUAL.TEX');
  assert.strictEqual(wrapped.size, 213 * 512);
  assert.strictEqual(wrapped.rights, 'rwx------');  // group and world are empty
});

test('VMS: version numbers are kept when the site asks for them', () => {
  const line = 'FILE.TXT;7          18/18          6-MAR-2006 12:34:56 [GROUP,USER] (RWED,RWED,RWED,RE)';
  assert.strictEqual(parseVmsRecord(line, { trimVmsVersions: false }).name, 'FILE.TXT;7');
  assert.strictEqual(parseVmsRecord(line, { trimVmsVersions: true }).name, 'FILE.TXT');
});

test('MLSD: facts are read, and cdir/pdir are dropped', () => {
  const raw = [
    'type=cdir;modify=20200303092200; /pub',
    'type=pdir;modify=20200303092200; /',
    'type=dir;sizd=4096;modify=20190112101500;UNIX.mode=0755;UNIX.ownername=root;UNIX.groupname=wheel; folder',
    'type=file;size=1234;modify=20200303092200.123;perm=adfrw;UNIX.mode=0644;UNIX.owner=1000;UNIX.group=1000; report.txt',
    'type=OS.unix=slink:/etc/nginx;perm=; link name with spaces',
  ].join('\r\n');

  const items = parseListing(raw);
  assert.strictEqual(items.length, 3);

  const [dir, file, link] = items;

  assert.strictEqual(dir.name, 'folder');
  assert.strictEqual(dir.type, 'dir');
  assert.strictEqual(dir.rights, 'rwxr-xr-x');
  assert.strictEqual(dir.owner, 'root');
  assert.strictEqual(dir.group, 'wheel');

  assert.strictEqual(file.name, 'report.txt');
  assert.strictEqual(file.size, 1234);
  assert.strictEqual(file.rights, 'rw-r--r--');
  // MLSD timestamps are UTC — that is the entire point of preferring it.
  assert.strictEqual(file.mtime, Date.UTC(2020, 2, 3, 9, 22, 0, 123));
  assert.strictEqual(file.readOnly, false);

  assert.strictEqual(link.name, 'link name with spaces');
  assert.strictEqual(link.type, 'link');
  assert.strictEqual(link.isSymlink, true);
  assert.strictEqual(link.linkTarget, '/etc/nginx');
  assert.strictEqual(link.readOnly, true);        // perm= with no letters
});

test('a mixed / unknown listing still yields what it can', () => {
  const raw = [
    'garbage that is not a listing at all',
    '-rw-r--r--    1 root root  10 Mar  3 09:22 ok.txt',
  ].join('\n');
  const items = parseListing(raw, { style: 'unknown', now: NOW });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].name, 'ok.txt');
});

test('hidden files are flagged the way the panel expects', () => {
  const items = parseListing('-rw-------  1 me me  6 Mar  3 09:22 .netrc', { now: NOW });
  assert.strictEqual(items[0].hidden, true);
  assert.strictEqual(items[0].rights, 'rw-------');
});

test('rightsToOctal converts both notations SITE CHMOD accepts', () => {
  assert.strictEqual(rightsToOctal('rwxr-xr-x'), '755');
  assert.strictEqual(rightsToOctal('rw-r--r--'), '644');
  assert.strictEqual(rightsToOctal('rwsr-xr-x'), '755');   // setuid bit is not a mode digit here
  assert.strictEqual(rightsToOctal('---------'), '000');
  assert.strictEqual(rightsToOctal('600'), '600');         // already octal
});

test('ftpTimestamp formats MFMT arguments in UTC', () => {
  assert.strictEqual(ftpTimestamp(Date.UTC(2020, 2, 3, 9, 22, 5)), '20200303092205');
  assert.strictEqual(ftpTimestamp(Date.UTC(1999, 11, 31, 23, 59, 59)), '19991231235959');
});

test('parseMlsdLine rejects a line with no name', () => {
  assert.strictEqual(parseMlsdLine('type=file;size=1'), null);
});

test('listing sizes reject unsafe and overflowing remote values', () => {
  const unix = parseUnixLine('-rw-r--r-- 1 root root 9007199254740992 Jan 1 2024 huge.bin', NOW);
  const dos = parseDosLine('01-01-2024  12:00AM  999999999999999999999 huge.bin');
  const mlsd = parseMlsdLine('type=file;size=Infinity;modify=20240101000000; huge.bin');
  assert.strictEqual(unix.size, 0);
  assert.strictEqual(dos.size, 0);
  assert.strictEqual(mlsd.size, 0);
});

test('SIZE replies reject unsafe and overflowing remote values', () => {
  assert.strictEqual(listingSize(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.strictEqual(listingSize(Number.MAX_SAFE_INTEGER + 1), 0);
  assert.strictEqual(listingSize('9007199254740992'), 0);
});
