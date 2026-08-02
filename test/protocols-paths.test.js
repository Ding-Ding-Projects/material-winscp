// Path handling for every backend: the Windows shapes the local panel has to
// cope with, and the POSIX shapes every remote protocol uses. Both are checked
// on whatever host runs the suite — the helpers are pure, so a POSIX CI machine
// still proves the Windows behaviour.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { winPath, posixPath, helpersFor, LocalAdapter, parseRights, rightsFromMode } = require('../design/main/protocols/local');
const { SftpAdapter } = require('../design/main/protocols/sftp');
const { ScpAdapter } = require('../design/main/protocols/scp');

test.describe('Windows path shapes', () => {
  test('normalizes drive-rooted paths and folds separators', () => {
    assert.equal(winPath.normalize('C:\\Users\\me'), 'C:\\Users\\me');
    assert.equal(winPath.normalize('c:/users/me'), 'C:\\users\\me');
    assert.equal(winPath.normalize('C:\\\\Users//me\\'), 'C:\\Users\\me');
    assert.equal(winPath.normalize('C:'), 'C:\\');
    assert.equal(winPath.normalize('c:\\'), 'C:\\');
    assert.equal(winPath.normalize('D:temp'), 'D:\\temp');
  });

  test('resolves . and .. without escaping the root', () => {
    assert.equal(winPath.normalize('C:\\a\\.\\b\\..\\c'), 'C:\\a\\c');
    assert.equal(winPath.normalize('C:\\a\\..\\..\\..'), 'C:\\');
    assert.equal(winPath.normalize('C:/Users/../Temp/x'), 'C:\\Temp\\x');
  });

  test('understands UNC shares', () => {
    assert.equal(winPath.normalize('\\\\server\\share'), '\\\\server\\share');
    assert.equal(winPath.normalize('//server/share/a/../b'), '\\\\server\\share\\b');
    assert.equal(winPath.normalize('\\\\server\\share\\'), '\\\\server\\share');
    assert.equal(winPath.normalize('\\\\server'), '\\\\server');
    assert.ok(winPath.isRoot('\\\\server\\share'));
  });

  test('unwraps the \\\\?\\ long-path escapes', () => {
    assert.equal(winPath.normalize('\\\\?\\C:\\x\\y'), 'C:\\x\\y');
    assert.equal(winPath.normalize('\\\\?\\UNC\\srv\\shr\\f'), '\\\\srv\\shr\\f');
    assert.equal(winPath.normalize('\\\\.\\C:\\x'), 'C:\\x');
  });

  test('treats the empty path as the virtual root above the drives', () => {
    assert.equal(winPath.normalize(''), '');
    assert.equal(winPath.normalize(null), '');
    assert.equal(winPath.normalize('\\'), '');
    assert.ok(winPath.isVirtualRoot(''));
    assert.ok(!winPath.isVirtualRoot('C:\\'));
    assert.ok(!winPath.isRoot(''));
  });

  test('dirname walks up to the drive and then to the virtual root', () => {
    assert.equal(winPath.dirname('C:\\a\\b\\c.txt'), 'C:\\a\\b');
    assert.equal(winPath.dirname('C:\\a'), 'C:\\');
    assert.equal(winPath.dirname('C:\\'), '');
    assert.equal(winPath.dirname('\\\\srv\\shr\\a'), '\\\\srv\\shr');
    assert.equal(winPath.dirname('\\\\srv\\shr'), '');
    assert.equal(winPath.dirname(''), '');
  });

  test('basename names a root after itself', () => {
    assert.equal(winPath.basename('C:\\a\\b.txt'), 'b.txt');
    assert.equal(winPath.basename('C:\\a\\'), 'a');
    assert.equal(winPath.basename('C:\\'), 'C:\\');
    assert.equal(winPath.basename('\\\\srv\\shr'), '\\\\srv\\shr');
    assert.equal(winPath.basename(''), '');
  });

  test('join drops empty parts and re-normalizes', () => {
    assert.equal(winPath.join('C:\\a', 'b', '..', 'c'), 'C:\\a\\c');
    assert.equal(winPath.join('C:\\', 'Users'), 'C:\\Users');
    assert.equal(winPath.join('', 'C:'), 'C:\\');
    assert.equal(winPath.join('C:\\a', '', null, undefined, 'b'), 'C:\\a\\b');
    assert.equal(winPath.join('\\\\srv\\shr', 'a', 'b'), '\\\\srv\\shr\\a\\b');
  });

  test('keeps track of what is absolute and what the root is', () => {
    assert.ok(winPath.isAbsolute('C:\\a'));
    assert.ok(winPath.isAbsolute('\\\\srv\\shr'));
    assert.ok(!winPath.isAbsolute('a\\b'));
    assert.equal(winPath.rootOf('C:\\a\\b'), 'C:\\');
    assert.equal(winPath.rootOf('\\\\srv\\shr\\a'), '\\\\srv\\shr');
    assert.equal(winPath.rootOf('a\\b'), '');
  });
});

test.describe('POSIX path shapes', () => {
  test('normalizes absolute and relative paths', () => {
    assert.equal(posixPath.normalize('/a/b/../c'), '/a/c');
    assert.equal(posixPath.normalize('/a/./b//c/'), '/a/b/c');
    assert.equal(posixPath.normalize('//a/b'), '/a/b');
    assert.equal(posixPath.normalize('/'), '/');
    assert.equal(posixPath.normalize(''), '/');
    assert.equal(posixPath.normalize('a/b'), 'a/b');
    assert.equal(posixPath.normalize('/..'), '/');
  });

  test('treats a backslash as an ordinary file-name character', () => {
    assert.equal(posixPath.normalize('/tmp/a\\b'), '/tmp/a\\b');
    assert.equal(posixPath.basename('/tmp/a\\b'), 'a\\b');
  });

  test('dirname and basename', () => {
    assert.equal(posixPath.dirname('/a/b/c'), '/a/b');
    assert.equal(posixPath.dirname('/a'), '/');
    assert.equal(posixPath.dirname('/'), '/');
    assert.equal(posixPath.basename('/a/b/c.txt'), 'c.txt');
    assert.equal(posixPath.basename('/a/b/'), 'b');
    assert.equal(posixPath.basename('/'), '/');
  });

  test('join', () => {
    assert.equal(posixPath.join('/a', 'b', '..', 'c'), '/a/c');
    assert.equal(posixPath.join('/', 'a'), '/a');
    assert.equal(posixPath.join('/a', '', null, 'b'), '/a/b');
  });
});

test.describe('adapters expose the right helpers', () => {
  test('the local adapter follows the platform it was told about', () => {
    const win = new LocalAdapter({ platform: 'win32' });
    assert.equal(win.sep, '\\');
    assert.equal(win.normalize('c:/a/b'), 'C:\\a\\b');
    assert.equal(win.join('C:\\a', 'b'), 'C:\\a\\b');
    assert.equal(win.dirname('C:\\a\\b'), 'C:\\a');
    assert.equal(win.basename('C:\\a\\b'), 'b');
    assert.ok(win.isVirtualRoot(''));
    assert.equal(win.caps.rights, false, 'Windows has no POSIX permission bits');
    assert.equal(win.caps.resume, true);
    assert.equal(win.caps.symlink, true);
    assert.equal(win.caps.timestamp, true);
    assert.equal(win.caps.find, true);

    const nix = new LocalAdapter({ platform: 'linux' });
    assert.equal(nix.sep, '/');
    assert.equal(nix.normalize('/a/./b/../c'), '/a/c');
    assert.equal(nix.caps.rights, true);
    assert.ok(!nix.isVirtualRoot('/'), 'only Windows has a root above the roots');
    assert.equal(helpersFor('win32'), winPath);
    assert.equal(helpersFor('darwin'), posixPath);
  });

  test('the remote adapters stay POSIX', () => {
    for (const A of [SftpAdapter, ScpAdapter]) {
      const a = new A({});
      assert.equal(a.sep, '/');
      assert.equal(a.normalize('/a/./b/../c'), '/a/c');
      assert.equal(a.normalize(''), '/');
      assert.equal(a.join('/a', 'b'), '/a/b');
      assert.equal(a.dirname('/a/b'), '/a');
      assert.equal(a.basename('/a/b'), 'b');
    }
  });

  test('the capability matrices say what each protocol can really do', () => {
    const sftp = new SftpAdapter({}).caps;
    assert.deepEqual(
      { rights: sftp.rights, owner: sftp.owner, exec: sftp.exec, resume: sftp.resume, symlink: sftp.symlink },
      { rights: true, owner: true, exec: true, resume: true, symlink: true },
    );

    const scp = new ScpAdapter({}).caps;
    assert.deepEqual(
      { rights: scp.rights, owner: scp.owner, exec: scp.exec, resume: scp.resume, symlink: scp.symlink },
      { rights: true, owner: true, exec: true, resume: false, symlink: true },
    );
  });
});

test.describe('permission strings', () => {
  test('round-trip between mode and rights', () => {
    assert.equal(rightsFromMode(0o644), 'rw-r--r--');
    assert.equal(rightsFromMode(0o755), 'rwxr-xr-x');
    assert.equal(rightsFromMode(0o4755), 'rwsr-xr-x');
    assert.equal(rightsFromMode(0o1777), 'rwxrwxrwt');
    assert.equal(parseRights('rw-r--r--'), 0o644);
    assert.equal(parseRights('rwxr-xr-x'), 0o755);
    assert.equal(parseRights('0644'), 0o644);
    assert.equal(parseRights('755'), 0o755);
    assert.equal(parseRights('not a mode'), null);
    assert.equal(parseRights(rightsFromMode(0o4755)) & 0o7777, 0o4755);
  });
});
