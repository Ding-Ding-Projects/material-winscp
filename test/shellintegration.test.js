// shellintegration.test.js — the Windows integration layer.
//
// Covers both modules of the unit:
//   design/main/setup.js            windows/Setup.cpp, Tools.cpp, WinMain.cpp
//   design/main/shellintegration.js dragext/ + the drag paths in
//                                   forms/CustomScpExplorer.cpp
//
// The expected values are what the C++ produces, taken from the line numbers
// named in each test. Where WinSCP refuses to do something — a %PATH% that
// would grow too long, an uninstall that would strip another application's
// protocol handler, a drop whose target cannot be determined — the refusal is
// asserted, because a port that only reproduces the happy path is not a port.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const S = require('../design/main/setup');
const SI = require('../design/main/shellintegration');

// ===========================================================================
// A fake registry: an in-memory tree behind the same reg.exe argv the real
// Registry builds, so the argv itself is exercised rather than bypassed.
// ===========================================================================

function fakeRegistry(initial) {
  /** key (lower) -> Map(valueName -> {value,type}) */
  const keys = new Map();
  const norm = (k) => String(k).toLowerCase();

  const ensure = (k) => {
    if (!keys.has(norm(k))) keys.set(norm(k), { name: k, values: new Map() });
    return keys.get(norm(k));
  };
  for (const [k, values] of Object.entries(initial || {})) {
    const rec = ensure(k);
    for (const [n, v] of Object.entries(values)) rec.values.set(n, { value: v, type: 'REG_SZ' });
  }

  const run = (args) => {
    const [op, fullKey] = args;
    const key = fullKey.replace(/^HK[A-Z]+\\/, '');
    const veIndex = args.indexOf('/ve');
    const vIndex = args.indexOf('/v');
    const name = veIndex >= 0 ? '' : (vIndex >= 0 ? args[vIndex + 1] : undefined);

    if (op === 'add') {
      const rec = ensure(key);
      const d = args.indexOf('/d');
      const t = args.indexOf('/t');
      rec.values.set(name === undefined ? '' : name, { value: args[d + 1], type: args[t + 1] });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (op === 'delete') {
      if (name === undefined) {
        // Deleting a key removes its whole subtree, exactly as reg.exe does.
        let hit = false;
        for (const k of [...keys.keys()]) {
          if (k === norm(key) || k.startsWith(`${norm(key)}\\`)) { keys.delete(k); hit = true; }
        }
        return { status: hit ? 0 : 1, stdout: '', stderr: '' };
      }
      const rec = keys.get(norm(key));
      if (!rec || !rec.values.has(name)) return { status: 1, stdout: '', stderr: '' };
      rec.values.delete(name);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (op === 'query') {
      const rec = keys.get(norm(key));
      const hasChildren = [...keys.keys()].some((k) => k.startsWith(`${norm(key)}\\`));
      if (!rec && !hasChildren) return { status: 1, stdout: '', stderr: '' };
      if (name !== undefined) {
        if (!rec || !rec.values.has(name)) return { status: 1, stdout: '', stderr: '' };
        const v = rec.values.get(name);
        return { status: 0, stdout: `\r\nHKCU\\${key}\r\n    ${name === '' ? '(Default)' : name}    ${v.type}    ${v.value}\r\n\r\n`, stderr: '' };
      }
      let out = `\r\nHKCU\\${key}\r\n`;
      if (rec) {
        for (const [n, v] of rec.values) out += `    ${n === '' ? '(Default)' : n}    ${v.type}    ${v.value}\r\n`;
      }
      out += '\r\n';
      const seen = new Set();
      for (const k of keys.keys()) {
        if (!k.startsWith(`${norm(key)}\\`)) continue;
        const child = keys.get(k).name.slice(String(key).length + 1);
        const first = child.split('\\')[0];
        if (first && !seen.has(first)) { seen.add(first); out += `HKCU\\${key}\\${first}\r\n`; }
      }
      return { status: 0, stdout: out, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unknown' };
  };

  return { run, keys, has: (k) => keys.has(norm(k)) };
}

// ===========================================================================
// Search path — Setup.cpp:146-266
// ===========================================================================

test('unquote strips a surrounding pair of quotes and nothing else', () => {
  assert.equal(S.unquote('"C:\\Program Files\\App"'), 'C:\\Program Files\\App');
  assert.equal(S.unquote('C:\\App'), 'C:\\App');
  assert.equal(S.unquote('"unbalanced'), '"unbalanced');
  assert.equal(S.unquote(''), '');
});

test('findPathEntry matches an entry regardless of case, quoting or trailing slash', () => {
  const p = 'C:\\Windows;"C:\\Program Files\\App";C:\\Other\\';
  assert.ok(S.findPathEntry(p, 'c:\\windows'));
  assert.ok(S.findPathEntry(p, 'C:\\Program Files\\App'));
  assert.ok(S.findPathEntry(p, 'C:\\Other'));
  assert.equal(S.findPathEntry(p, 'C:\\Missing'), null);
});

test('findPathEntry skips empty entries, as wcstok does', () => {
  const found = S.findPathEntry('C:\\a;;C:\\b', 'C:\\b');
  assert.ok(found);
  assert.equal(found.start, 6);
});

test('addToPath appends once and never twice', () => {
  const first = S.addToPath('C:\\a;C:\\b', 'C:\\c');
  assert.deepEqual(first, { value: 'C:\\a;C:\\b;C:\\c', changed: true });
  const again = S.addToPath(first.value, 'C:\\c');
  assert.equal(again.changed, false);
  assert.equal(again.alreadyPresent, true);
  assert.equal(again.value, first.value);
});

test('addToPath handles an empty %PATH% without a leading separator', () => {
  assert.equal(S.addToPath('', 'C:\\app').value, 'C:\\app');
});

// Setup.cpp:182 — "when the PATH registry key is over aprox 2048 characters,
// PATH as well as WINDIR variables are actually not set, breaking the system".
test('addToPath refuses rather than truncating when %PATH% would get too long', () => {
  const long = 'C:\\x'.repeat(Math.ceil(S.MAX_PATH_LEN / 4));
  const r = S.addToPath(long, 'C:\\app');
  assert.equal(r.changed, false);
  assert.equal(r.value, long, 'the existing %PATH% must be left exactly as it was');
  assert.match(r.error, /already too long/);
});

test('removeFromPath splices the entry out and drops a leftover trailing separator', () => {
  assert.deepEqual(S.removeFromPath('C:\\a;C:\\b;C:\\c', 'C:\\b'), { value: 'C:\\a;C:\\c', changed: true });
  assert.deepEqual(S.removeFromPath('C:\\a;C:\\b', 'C:\\b'), { value: 'C:\\a', changed: true });
  assert.deepEqual(S.removeFromPath('C:\\a;C:\\b', 'C:\\a'), { value: 'C:\\b', changed: true });
  assert.deepEqual(S.removeFromPath('C:\\a', 'C:\\a'), { value: '', changed: true });
});

test('removeFromPath leaves an absent entry alone', () => {
  assert.deepEqual(S.removeFromPath('C:\\a;C:\\b', 'C:\\z'), { value: 'C:\\a;C:\\b', changed: false });
});

// ===========================================================================
// Registry plumbing
// ===========================================================================

test('regArgs addresses the default value with /ve and a named one with /v', () => {
  assert.deepEqual(S.regArgs({ op: 'add', root: 'HKCU', key: 'Software\\X', name: '', value: 'hi' }),
    ['add', 'HKCU\\Software\\X', '/ve', '/t', 'REG_SZ', '/d', 'hi', '/f']);
  assert.deepEqual(S.regArgs({ op: 'add', root: 'HKCU', key: 'Software\\X', name: 'N', value: '1', type: 'REG_DWORD' }),
    ['add', 'HKCU\\Software\\X', '/v', 'N', '/t', 'REG_DWORD', '/d', '1', '/f']);
  assert.deepEqual(S.regArgs({ op: 'delete', root: 'HKCU', key: 'Software\\X' }),
    ['delete', 'HKCU\\Software\\X', '/f']);
  assert.deepEqual(S.regArgs({ op: 'query', root: 'HKCU', key: 'Software\\X', name: 'N' }),
    ['query', 'HKCU\\Software\\X', '/v', 'N']);
});

test('regArgs refuses an operation it does not know', () => {
  assert.throws(() => S.regArgs({ op: 'frobnicate', key: 'X' }), /Unknown registry operation/);
});

test('reg query output is parsed for values and for names', () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\X\r\n' +
    '    (Default)    REG_SZ    the description\r\n' +
    '    URL Protocol    REG_SZ    \r\n' +
    '    EditFlags    REG_DWORD    0x2\r\n\r\n';
  assert.equal(S.parseRegQueryValue(out, ''), 'the description');
  assert.equal(S.parseRegQueryValue(out, 'EditFlags'), '0x2');
  assert.equal(S.parseRegQueryValue(out, 'Nope'), undefined);
  assert.deepEqual(S.parseRegQueryNames(out), ['', 'URL Protocol', 'EditFlags']);
});

// Setup.cpp:293 DeleteKeyIfEmpty.
test('canDeleteKey allows only the four values the registration itself writes', () => {
  assert.equal(S.canDeleteKey([], false), true);
  assert.equal(S.canDeleteKey(['EditFlags'], false), false, 'without allowRootValues any value blocks the delete');
  assert.equal(S.canDeleteKey(['', 'URL Protocol', 'EditFlags', 'BrowserFlags'], true), true);
  assert.equal(S.canDeleteKey(['', 'SomeoneElse'], true), false);
});

test('Registry round-trips through the fake reg.exe', () => {
  const fake = fakeRegistry();
  const r = new S.Registry({ run: fake.run });
  r.add('Software\\X', '', 'hello');
  r.add('Software\\X', 'N', '7', 'REG_DWORD');
  assert.equal(r.read('Software\\X', ''), 'hello');
  assert.equal(r.read('Software\\X', 'N'), '7');
  assert.deepEqual(r.valueNames('Software\\X').sort(), ['', 'N']);
  assert.equal(r.exists('Software\\X'), true);
  assert.equal(r.exists('Software\\Nope'), false);
  assert.equal(r.read('Software\\Nope', ''), undefined);
});

test('Registry.add reports a write it could not perform', () => {
  const r = new S.Registry({ run: () => ({ status: 1, stdout: '', stderr: 'ACCESS DENIED' }) });
  assert.throws(() => r.add('Software\\X', '', 'v'), /Cannot write registry key/);
});

test('deleting a value that is not there is not an error', () => {
  const r = new S.Registry({ run: fakeRegistry().run });
  assert.equal(r.delete('Software\\Nothing', 'N'), false);
});

test('deleteKeyIfEmpty recurses and refuses a key another application owns', () => {
  const fake = fakeRegistry({
    'Software\\Classes\\sftp': { '': 'URL: sftp Protocol', 'URL Protocol': '', EditFlags: '0x2' },
    'Software\\Classes\\sftp\\shell\\open\\command': {},
    'Software\\Classes\\ftp': { '': 'FTP', SomeOtherApp: 'yes' },
  });
  const r = new S.Registry({ run: fake.run });

  assert.equal(r.deleteKeyIfEmpty('Software\\Classes\\sftp', true).deleted, true);
  assert.equal(fake.has('Software\\Classes\\sftp'), false);
  assert.equal(fake.has('Software\\Classes\\sftp\\shell\\open\\command'), false);

  const kept = r.deleteKeyIfEmpty('Software\\Classes\\ftp', true);
  assert.equal(kept.deleted, false);
  assert.equal(kept.reason, 'has-foreign-values');
  assert.equal(fake.has('Software\\Classes\\ftp'), true);
});

// `reg query HKCU\X` prints `HKEY_CURRENT_USER\X\Child`, never `HKCU\X\Child`.
// If the subkey scan only understands the abbreviation it finds nothing, and
// then `reg delete /f` — which IS recursive — takes a subkey another
// application owns down with it. That is the one refusal that must not depend
// on how reg.exe spells the root.
test('subkeys are read from the long root name reg.exe actually prints', () => {
  const run = (args) => {
    const key = args[1];
    if (args[0] !== 'query') return { status: 0, stdout: '', stderr: '' };
    if (/\\shell$/i.test(key)) {
      return { status: 0, stdout: '\r\nHKEY_CURRENT_USER\\Software\\Classes\\sftp\\shell\r\n\r\nHKEY_CURRENT_USER\\Software\\Classes\\sftp\\shell\\open\r\n', stderr: '' };
    }
    if (/\\sftp$/i.test(key)) {
      return {
        status: 0,
        stdout: '\r\nHKEY_CURRENT_USER\\Software\\Classes\\sftp\r\n' +
          '    (Default)    REG_SZ    URL: sftp Protocol\r\n\r\n' +
          'HKEY_CURRENT_USER\\Software\\Classes\\sftp\\shell\r\n',
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: '' };
  };
  const r = new S.Registry({ run });
  assert.deepEqual(r.subKeys('Software\\Classes\\sftp'), ['shell']);
  assert.deepEqual(r.subKeys('Software\\Classes\\sftp\\shell'), ['open']);

  // The `open` subkey never goes away in this fake, so the parent must refuse.
  const result = r.deleteKeyIfEmpty('Software\\Classes\\sftp', true);
  assert.equal(result.deleted, false);
  assert.equal(result.reason, 'has-subkeys');
  assert.equal(
    r.performed.some((p) => p.op === 'delete' && p.name === undefined && /sftp$/i.test(p.key)),
    false,
    'a recursive reg delete must never be issued while a subkey survives');
});

// ===========================================================================
// Protocol registration — Setup.cpp:341-709
// ===========================================================================

test('protocolOperations writes exactly the values WinSCP writes', () => {
  const ops = S.protocolOperations('sftp', 'C:\\App\\WinSCP.exe');
  const find = (key, name) => ops.find((o) => o.key === key && o.name === name);
  assert.equal(find('Software\\Classes\\sftp', '').value, 'URL: sftp Protocol');
  assert.equal(find('Software\\Classes\\sftp', 'URL Protocol').value, '');
  // FTA_OpenIsSafe and "do not confirm opening".
  assert.deepEqual(
    [find('Software\\Classes\\sftp', 'EditFlags').value, find('Software\\Classes\\sftp', 'BrowserFlags').value],
    ['0x2', '0x8']);
  assert.equal(find('Software\\Classes\\sftp\\DefaultIcon', '').value, '"C:\\App\\WinSCP.exe",0');
  assert.equal(find('Software\\Classes\\sftp\\shell\\open\\command', '').value,
    '"C:\\App\\WinSCP.exe" /Unsafe "%1"');
});

// Setup.cpp:410. The switch is what stops a web link from becoming a command line.
test('the URL handler command always carries /Unsafe', () => {
  for (const proto of S.allRegisteredProtocols()) {
    const ops = S.protocolOperations(proto, 'X.exe');
    const cmd = ops.find((o) => o.key.endsWith('shell\\open\\command'));
    assert.match(cmd.value, /\/Unsafe "%1"$/, `${proto} must be registered with /Unsafe`);
  }
});

test('http is deliberately absent from the Default Programs registration', () => {
  // Setup.cpp:621 — "it's unlikely that anyone would like to change http
  // handler to non-browser application".
  assert.equal(S.defaultProgramProtocols().includes('http'), false);
  assert.equal(S.defaultProgramProtocols().includes('https'), false);
  // ...but the winscp- prefixed forms of both DO exist, Setup.cpp:682.
  assert.ok(S.prefixedProtocols().includes('winscp-HTTP'));
  assert.ok(S.prefixedProtocols().includes('winscp-HTTPS'));
});

test('the prefixed protocol names are upper-cased, as RegisterAsNonBrowserUrlHandler does', () => {
  assert.deepEqual(S.prefixedProtocols().slice(0, 5),
    ['winscp-SFTP', 'winscp-SCP', 'winscp-DAV', 'winscp-DAVS', 'winscp-S3']);
});

test('the registration plan registers the application and its capabilities', () => {
  const plan = S.registrationPlan('C:\\App\\x.exe', { appName: 'WinSCP Material', companyKey: 'Software\\Co' });
  const registered = plan.find((o) => o.key === 'Software\\RegisteredApplications');
  assert.equal(registered.name, 'WinSCP Material');
  assert.equal(registered.value, 'Software\\Co\\WinSCPCapabilities');
  const assoc = plan.filter((o) => o.key === 'Software\\Co\\WinSCPCapabilities\\UrlAssociations');
  assert.deepEqual(assoc.map((o) => o.name).sort(), S.defaultProgramProtocols().slice().sort());
  for (const a of assoc) assert.equal(a.value, S.GENERIC_URL_HANDLER);
  assert.ok(plan.some((o) => o.key === `Software\\Classes\\${S.GENERIC_URL_HANDLER}`));
});

test('registerForDefaultProtocols writes the plan and reports what failed', () => {
  const fake = fakeRegistry();
  const integ = new S.WindowsIntegration({
    exePath: 'C:\\App\\x.exe', appName: 'App', companyKey: 'Software\\Co',
    registry: new S.Registry({ run: fake.run }),
  });
  const r = integ.registerForDefaultProtocols();
  assert.equal(r.failed.length, 0);
  assert.ok(r.written > 100);
  assert.equal(fake.has('Software\\Classes\\sftp\\shell\\open\\command'), true);
  assert.equal(fake.has('Software\\RegisteredApplications'), true);
});

test('registerForDefaultProtocols reports the WinSCP error when nothing can be written', () => {
  const integ = new S.WindowsIntegration({
    exePath: 'x.exe',
    registry: new S.Registry({ run: () => ({ status: 5, stdout: '', stderr: 'denied' }) }),
  });
  assert.throws(() => integ.registerForDefaultProtocols(), /Cannot register application to handle URL addresses/);
});

// Setup.cpp:457 — the unregistration only removes a handler that still names us.
test('unregisterForProtocols leaves a protocol another application has taken over', () => {
  const fake = fakeRegistry();
  const integ = new S.WindowsIntegration({
    exePath: 'C:\\App\\Material.exe', appName: 'App', companyKey: 'Software\\Co',
    registry: new S.Registry({ run: fake.run }),
  });
  integ.registerForDefaultProtocols();

  // Another client claims sftp: after we did.
  const reg = new S.Registry({ run: fake.run });
  reg.add('Software\\Classes\\sftp\\shell\\open\\command', '', '"C:\\Other\\Rival.exe" "%1"');
  reg.add('Software\\Classes\\sftp\\DefaultIcon', '', '"C:\\Other\\Rival.exe",0');

  const r = integ.unregisterForProtocols();
  assert.ok(r.kept.includes('Software\\Classes\\sftp'), 'a foreign sftp handler must survive an uninstall');
  assert.equal(fake.has('Software\\Classes\\sftp\\shell\\open\\command'), true);
  // Ours went.
  assert.ok(r.removed.includes('Software\\Classes\\winscp-SFTP'));
  assert.equal(fake.has('Software\\Classes\\winscp-SFTP'), false);
});

test('unregisterForProtocols unregisters the application once its capabilities key is gone', () => {
  const fake = fakeRegistry();
  const integ = new S.WindowsIntegration({
    exePath: 'C:\\App\\Material.exe', appName: 'App', companyKey: 'Software\\Co',
    registry: new S.Registry({ run: fake.run }),
  });
  integ.registerForDefaultProtocols();
  integ.unregisterForProtocols();
  assert.equal(new S.Registry({ run: fake.run }).read('Software\\RegisteredApplications', 'App'), undefined);
  assert.equal(fake.has('Software\\Co\\WinSCPCapabilities'), false);
});

// ===========================================================================
// Search path through the integration object
// ===========================================================================

test('addSearchPath writes REG_EXPAND_SZ and says a new shell is needed', () => {
  const fake = fakeRegistry({ Environment: { Path: 'C:\\Windows' } });
  const integ = new S.WindowsIntegration({
    exePath: 'C:\\App\\x.exe', registry: new S.Registry({ run: fake.run }),
  });
  const r = integ.addSearchPath();
  assert.equal(r.changed, true);
  assert.equal(r.value, 'C:\\Windows;C:\\App');
  assert.equal(r.requiresNewShell, true);
  const written = fake.keys.get('environment').values.get('Path');
  assert.equal(written.type, 'REG_EXPAND_SZ');
});

test('addSearchPath is idempotent', () => {
  const fake = fakeRegistry({ Environment: { Path: 'C:\\App' } });
  const integ = new S.WindowsIntegration({ exePath: 'C:\\App\\x.exe', registry: new S.Registry({ run: fake.run }) });
  assert.deepEqual(integ.addSearchPath(), { changed: false, alreadyPresent: true });
});

test('addSearchPath throws WinSCP\'s error when %PATH% is already too long', () => {
  const long = 'C:\\x'.repeat(Math.ceil(S.MAX_PATH_LEN / 4));
  const fake = fakeRegistry({ Environment: { Path: long } });
  const integ = new S.WindowsIntegration({ exePath: 'C:\\App\\x.exe', registry: new S.Registry({ run: fake.run }) });
  assert.throws(() => integ.addSearchPath(), /Error adding path .* to search path/);
});

// WinMain.cpp:1046 — "ignore errors ... RemoveSearchPath is called always on
// uninstallation, even if AddSearchPath was not used".
test('removeSearchPath never throws, even when the registry refuses', () => {
  const integ = new S.WindowsIntegration({
    exePath: 'C:\\App\\x.exe',
    registry: new S.Registry({ run: () => ({ status: 5, stdout: '', stderr: 'denied' }) }),
  });
  assert.doesNotThrow(() => integ.removeSearchPath());
  assert.equal(integ.removeSearchPath().changed, false);
});

// ===========================================================================
// Shortcut naming — Tools.cpp:606, Login.cpp:1830, Preferences.cpp:1633
// ===========================================================================

test('validLocalFileName replaces the characters Windows will not accept', () => {
  assert.equal(S.validLocalFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(S.validLocalFileName('ordinary name'), 'ordinary name');
  assert.equal(S.validLocalFileName('///'), '___');
  assert.equal(S.validLocalFileName(''), '_');
});

test('the Send To shortcut names match WinSCP\'s resource strings', () => {
  // TextsWin1.rc:182 and :181.
  assert.equal(S.sendToHookName('WinSCP Material'), 'WinSCP Material (for upload)');
  assert.equal(S.sessionSendToHookName('work', 'WinSCP Material'), 'work (upload using WinSCP Material)');
});

test('shortcut info tips differ for a site, a folder and a workspace', () => {
  // TextsWin1.rc:177, 248, 249.
  assert.match(S.shortcutInfoTip({ name: 'work', hostName: 'h' }), /^Opens site 'work'\n/);
  assert.equal(S.shortcutInfoTip({ name: 'group', isFolder: true }), "Opens site folder 'group'");
  assert.equal(S.shortcutInfoTip({ name: 'ws', isWorkspace: true }), "Opens workspace 'ws'");
});

test('a session info tip never contains the password', () => {
  const tip = S.sessionInfoTip({ userName: 'martin', hostName: 'h', password: 'hunter2', protocol: 'sftp' });
  assert.equal(tip.includes('hunter2'), false);
  assert.match(tip, /User name: martin/);
});

test('appShortcutParams carries the /ini switch of a portable install', () => {
  const integ = new S.WindowsIntegration({ exePath: 'x.exe', iniParam: 'D:\\p\\WinSCP.ini' });
  assert.equal(integ.appShortcutParams('/Upload'), '/ini="D:\\p\\WinSCP.ini" /Upload');
  const plain = new S.WindowsIntegration({ exePath: 'x.exe' });
  assert.equal(plain.appShortcutParams('/Upload'), '/Upload');
});

test('specialFolder resolves the Send To and Start Menu locations', () => {
  const integ = new S.WindowsIntegration({
    exePath: 'x.exe',
    env: { APPDATA: 'C:\\Users\\m\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\m', PUBLIC: 'C:\\Users\\Public' },
  });
  assert.equal(integ.specialFolder('sendTo'), path.join('C:\\Users\\m\\AppData\\Roaming', 'Microsoft', 'Windows', 'SendTo'));
  assert.equal(integ.specialFolder('startMenu'), path.join('C:\\Users\\m\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  assert.equal(integ.specialFolder('commonDesktop'), path.join('C:\\Users\\Public', 'Desktop'));
  assert.throws(() => integ.specialFolder('nowhere'), /Unknown shortcut folder/);
});

test('creating a shortcut without Electron reports it rather than failing silently', () => {
  const integ = new S.WindowsIntegration({ exePath: 'x.exe', env: { APPDATA: os.tmpdir(), USERPROFILE: os.tmpdir() } });
  assert.throws(() => integ.createShortcut({ name: 'x' }), /Shortcuts are a Windows feature|Cannot create shortcut/);
});

// ===========================================================================
// Temporary folders — Setup.cpp:732, WinConfiguration.cpp:2601
// ===========================================================================

test('uniqTempDir produces a name inside the scp????? mask', () => {
  const dir = S.uniqTempDir('C:\\Temp', 'scp', { exists: () => false, now: () => new Date(2026, 0, 1, 12, 7, 0, 42) });
  assert.equal(path.basename(dir), 'scp07042');
  assert.ok(S.isTemporaryFolderName(path.basename(dir)));
});

test('uniqTempDir keeps trying until the name is free', () => {
  const taken = new Set(['scp07042', 'scp07043']);
  const dir = S.uniqTempDir('C:\\Temp', 'scp', {
    exists: (p) => taken.has(path.basename(p)),
    now: () => new Date(2026, 0, 1, 12, 7, 0, 42),
  });
  assert.equal(path.basename(dir), 'scp07044');
});

test('the temporary-folder mask matches only names of the right shape', () => {
  assert.equal(S.isTemporaryFolderName('scp07042'), true);
  assert.equal(S.isTemporaryFolderName('scp0704'), false);
  assert.equal(S.isTemporaryFolderName('scp070422'), false);
  assert.equal(S.isTemporaryFolderName('tmp07042'), false);
});

test('findTemporaryFolders returns only matching directories', () => {
  const entries = [
    { name: 'scp07042', isDirectory: () => true },
    { name: 'scp07043', isDirectory: () => false },   // a file, not a folder
    { name: 'other', isDirectory: () => true },
  ];
  const found = S.findTemporaryFolders('C:\\Temp', { readdir: () => entries });
  assert.deepEqual(found, [path.join('C:\\Temp', 'scp07042')]);
});

test('cleanupTemporaryFolders names every folder it could not delete', () => {
  const stuck = 'C:\\Temp\\scp00002';
  assert.throws(() => S.cleanupTemporaryFolders(['C:\\Temp\\scp00001', stuck], {
    remove: (p) => { if (p === stuck) throw new Error('in use'); },
  }), (e) => {
    assert.match(e.message, /Some of the temporary folders have not been deleted/);
    assert.deepEqual(e.detail, [stuck], 'the user must be told which folders are still there');
    return true;
  });
});

test('the temporary-folder cleanup honours every answer WinSCP offers', async () => {
  const entries = [{ name: 'scp00001', isDirectory: () => true }, { name: 'scp00002', isDirectory: () => true }];
  const opts = { readdir: () => entries, remove: () => undefined };

  const removed = [];
  const yes = await S.temporaryDirectoryCleanup('C:\\Temp',
    { ...opts, remove: (p) => removed.push(p), ask: async () => 'yes' });
  assert.equal(yes.deleted, 2);
  assert.equal(removed.length, 2);

  const no = await S.temporaryDirectoryCleanup('C:\\Temp', { ...opts, ask: async () => 'no' });
  assert.equal(no.deleted, 0);
  assert.equal(no.folders.length, 2);

  let confirmSetting = true;
  const never = await S.temporaryDirectoryCleanup('C:\\Temp',
    { ...opts, ask: async () => 'never', setConfirm: (v) => { confirmSetting = v; } });
  assert.equal(never.deleted, 2, '"never ask again" still performs the delete this time');
  assert.equal(confirmSetting, false);
});

test('the cleanup message states how many folders were found and why they exist', async () => {
  let seen = null;
  await S.temporaryDirectoryCleanup('C:\\Temp', {
    readdir: () => [{ name: 'scp00001', isDirectory: () => true }],
    remove: () => undefined,
    ask: async (q) => { seen = q; return 'no'; },
  });
  assert.match(seen.message, /found 1 temporary folders/);
  assert.match(seen.message, /previously edited or downloaded/);
  assert.equal(seen.folders.length, 1);
});

// Setup.cpp:770 — the cleanup runs during startup and catches its own failure,
// so a folder Explorer still holds open is reported, not thrown at the launch.
test('a folder that cannot be deleted is reported without failing the startup', async () => {
  const stuck = path.join('C:\\Temp', 'scp00002');
  const errors = [];
  const r = await S.temporaryDirectoryCleanup('C:\\Temp', {
    readdir: () => [{ name: 'scp00001', isDirectory: () => true }, { name: 'scp00002', isDirectory: () => true }],
    remove: (p) => { if (p === stuck) throw new Error('in use'); },
    ask: async () => 'yes',
    onError: (e) => errors.push(e),
  });
  assert.equal(r.deleted, 0);
  assert.match(r.error, /have not been deleted/);
  assert.deepEqual(r.failed, [stuck]);
  assert.equal(errors.length, 1);
});

test('nothing is asked when there are no temporary folders', async () => {
  let asked = false;
  const r = await S.temporaryDirectoryCleanup('C:\\Temp', {
    readdir: () => [], ask: async () => { asked = true; return 'yes'; },
  });
  assert.equal(asked, false);
  assert.deepEqual(r, { folders: [], deleted: 0 });
});

// ===========================================================================
// Jump list — Setup.cpp:1874-1959
// ===========================================================================

test('the jump list has the two categories WinSCP builds', () => {
  const j = S.buildJumpList(['work', 'home'], ['ws'], { exePath: 'C:\\App\\x.exe' });
  assert.deepEqual(j.categories.map((c) => c.name), ['Recent Workspaces', 'Recent Sites']);
  assert.equal(j.categories[0].items.length, 1);
  assert.equal(j.categories[1].items.length, 2);
});

test('only site entries carry /UploadIfAny, and every entry carries /JumpList', () => {
  const j = S.buildJumpList(['work'], ['ws'], { exePath: 'x.exe' });
  const [workspaces, sites] = j.categories;
  assert.equal(workspaces.items[0].args.includes('/UploadIfAny'), false);
  assert.ok(sites.items[0].args.includes('/UploadIfAny'));
  assert.ok(workspaces.items[0].args.includes('/JumpList'));
  assert.ok(sites.items[0].args.includes('/JumpList'));
});

test('an entry the user removed from the jump list is not offered again', () => {
  const j = S.buildJumpList(['work', 'home'], [], { exePath: 'x.exe', removed: ['Work'] });
  assert.deepEqual(j.keptSessions, ['home']);
  assert.equal(j.categories[0].items.length, 1);
});

test('an empty jump list produces no categories at all', () => {
  assert.deepEqual(S.buildJumpList([], [], {}).categories, []);
});

// AddJumpListCategory never adds a removed entry to the collection it appends.
// Applying a list that still contains one is refused by Windows, so what is
// APPLIED — not merely what is returned — has to be the filtered list.
test('the list applied to Windows is the one the removals were taken out of', () => {
  const applied = [];
  const app = {
    setJumpList: (c) => applied.push(c),
    getJumpListSettings: () => ({ removedItems: [{ title: 'home' }] }),
  };
  const r = S.updateJumpList(['work', 'home'], [], { app, exePath: 'x.exe' });
  assert.equal(r.applied, true);
  assert.deepEqual(r.keptSessions, ['work']);
  assert.equal(applied.length, 1);
  const titles = applied[0].flatMap((c) => c.items.map((i) => i.title));
  assert.deepEqual(titles, ['work'], 'the removed entry must not be pushed back at Windows');
});

test('with nothing removed the jump list is applied as built', () => {
  const applied = [];
  const app = { setJumpList: (c) => applied.push(c), getJumpListSettings: () => ({ removedItems: [] }) };
  const r = S.updateJumpList(['work'], ['ws'], { app, exePath: 'x.exe' });
  assert.equal(r.applied, true);
  assert.deepEqual(applied[0].map((c) => c.name), ['Recent Workspaces', 'Recent Sites']);
});

// ===========================================================================
// Instances and startup — Setup.cpp:1961, WinMain.cpp:710-1209
// ===========================================================================

test('anyOtherInstanceOfSelf ignores this process and matches on the exe name', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows process list');
  const stdout = '"Material.exe","4242","Console","1","10,000 K"\r\n' +
                 '"Material.exe","777","Console","1","10,000 K"\r\n' +
                 '"explorer.exe","9","Console","1","10,000 K"\r\n';
  const run = () => ({ status: 0, stdout });
  assert.equal(anyOther({ exePath: 'C:\\App\\Material.exe', pid: 4242, run }), true);
  assert.equal(anyOther({ exePath: 'C:\\App\\Other.exe', pid: 4242, run }), false);
  // Only this process is running: not "another instance".
  assert.equal(anyOther({
    exePath: 'C:\\App\\Material.exe', pid: 4242,
    run: () => ({ status: 0, stdout: '"Material.exe","4242","Console","1","10,000 K"\r\n' }),
  }), false);
  function anyOther(o) { return S.anyOtherInstanceOfSelf(o); }
});

// WinMain.cpp:1157 — every clause of TrySendToAnotherInstance.
test('a plain session URL is handed to the running instance', () => {
  assert.equal(S.shouldSendToAnotherInstance({ url: { hostName: 'h' } }, {}), true);
});

test('/newinstance, /rawconfig and a transfer command each keep the launch local', () => {
  const url = { hostName: 'h' };
  assert.equal(S.shouldSendToAnotherInstance({ url, newInstance: true }, {}), false);
  assert.equal(S.shouldSendToAnotherInstance({ url, rawConfig: true }, {}), false);
  assert.equal(S.shouldSendToAnotherInstance({ url, upload: true }, {}), false);
  assert.equal(S.shouldSendToAnotherInstance({ url, synchronize: '' }, {}), false);
  assert.equal(S.shouldSendToAnotherInstance({ url, keepUpToDate: '' }, {}), false);
  assert.equal(S.shouldSendToAnotherInstance({ url, edit: 'f' }, {}), false);
  assert.equal(S.shouldSendToAnotherInstance({ url, refresh: true }, {}), false);
});

test('Shift inverts the ExternalSessionInExistingInstance preference', () => {
  const url = { hostName: 'h' };
  assert.equal(S.shouldSendToAnotherInstance({ url }, { externalSessionInExistingInstance: true }), true);
  assert.equal(S.shouldSendToAnotherInstance({ url }, { externalSessionInExistingInstance: true, shiftHeld: true }), false);
  assert.equal(S.shouldSendToAnotherInstance({ url }, { externalSessionInExistingInstance: false }), false);
  assert.equal(S.shouldSendToAnotherInstance({ url }, { externalSessionInExistingInstance: false, shiftHeld: true }), true);
});

test('a URL naming a file to download stays in this process', () => {
  assert.equal(S.shouldSendToAnotherInstance({ url: { hostName: 'h', downloadFile: 'a.txt' } }, {}), false);
});

// WinMain.cpp:1168 uses GetFolderOrWorkspaceName only to decide whether the
// name is worth parsing as a URL — it is not a reason to keep the launch local.
// A workspace opened from the jump list is exactly what the running instance
// should take over.
test('a folder or workspace name is still handed to the running instance', () => {
  assert.equal(S.shouldSendToAnotherInstance({ siteName: 'group/' }, { isFolderOrWorkspace: true }), true);
  // ...and the download-file test does not apply to it, because a folder name
  // is not a URL and was never parsed as one.
  assert.equal(
    S.shouldSendToAnotherInstance({ siteName: 'ws', url: { downloadFile: 'a.txt' } }, { isFolderOrWorkspace: true }),
    true);
});

test('a launch with nothing to open opens here', () => {
  assert.equal(S.shouldSendToAnotherInstance({}, {}), false);
});

test('the usage counter names the way the app was launched', () => {
  assert.equal(S.commandCounterName({ jumpList: true }), 'CommandLineJumpList');
  assert.equal(S.commandCounterName({ desktop: true }), 'CommandLineDesktop');
  assert.equal(S.commandCounterName({ sendToHook: true }), 'CommandLineSendToHook');
  assert.equal(S.commandCounterName({}), 'CommandLineSession2');
});

test('the startup sequence records the stages a launch reached', () => {
  const seq = new S.StartupSequence();
  seq.add('X'); seq.add('C'); seq.add('R');
  assert.equal(String(seq), 'XCR');
  assert.equal(seq.times.length, 3);
});

// ===========================================================================
// Command splitting and PuTTY — Common.cpp:750-892, GUITools.cpp:406-613
// ===========================================================================

test('splitCommand keeps a quoted program together', () => {
  assert.deepEqual(S.splitCommand('"C:\\Program Files\\PuTTY\\putty.exe" -load foo'), {
    program: 'C:\\Program Files\\PuTTY\\putty.exe',
    params: '-load foo',
    dir: 'C:\\Program Files\\PuTTY\\',
  });
});

test('splitCommand ends an unquoted program at the first space', () => {
  assert.deepEqual(S.splitCommand('putty.exe -ssh host'), { program: 'putty.exe', params: '-ssh host', dir: '' });
  assert.deepEqual(S.splitCommand('  putty.exe  '), { program: 'putty.exe', params: '', dir: '' });
  assert.deepEqual(S.splitCommand(''), { program: '', params: '', dir: '' });
});

test('splitCommand refuses a command whose quote is never closed', () => {
  assert.throws(() => S.splitCommand('"C:\\Program Files\\putty.exe -load'), /Invalid shell command/);
});

test('formatCommand is the inverse and always quotes the program', () => {
  assert.equal(S.formatCommand('C:\\Program Files\\PuTTY\\putty.exe', '-load foo'),
    '"C:\\Program Files\\PuTTY\\putty.exe" -load foo');
  assert.equal(S.formatCommand('putty.exe', ''), '"putty.exe"');
  assert.equal(S.formatCommand('"already.exe"', ''), '"already.exe"');
});

test('environment variables expand case-insensitively and unknown ones are left alone', () => {
  const env = { ProgramFiles: 'C:\\Program Files' };
  assert.equal(S.expandEnvironmentVariables('%PROGRAMFILES%\\PuTTY\\putty.exe', env), 'C:\\Program Files\\PuTTY\\putty.exe');
  assert.equal(S.expandEnvironmentVariables('%NOSUCHVAR%\\x', env), '%NOSUCHVAR%\\x');
  assert.equal(S.expandEnvironmentVariables('', env), '');
});

// Common.cpp:850 — backslashes double only in front of a quote.
test('escapePuttyCommandParam matches PuTTY\'s own quoting rules', () => {
  assert.equal(S.escapePuttyCommandParam('plain'), 'plain');
  assert.equal(S.escapePuttyCommandParam('two words'), '"two words"');
  assert.equal(S.escapePuttyCommandParam('C:\\keys\\id.ppk'), 'C:\\keys\\id.ppk');
  assert.equal(S.escapePuttyCommandParam('say "hi"'), '"say \\"hi\\""');
  assert.equal(S.escapePuttyCommandParam('a\\\\"b'), 'a\\\\\\\\\\"b');
  assert.equal(S.escapePuttyCommandParam('ends\\'), 'ends\\');
  assert.equal(S.escapePuttyCommandParam(''), '');
});

test('findTool looks beside the app, then in PuTTY\\, then on %PATH%', () => {
  const present = new Set();
  const opts = (extra) => ({ exists: (p) => present.has(p), appDir: 'C:\\App', env: { PATH: 'C:\\Bin' }, ...extra });

  present.clear();
  present.add(path.join('C:\\App', 'pageant.exe'));
  assert.equal(S.findTool('pageant.exe', opts()), path.join('C:\\App', 'pageant.exe'));

  present.clear();
  present.add(path.join('C:\\App', 'PuTTY', 'pageant.exe'));
  assert.equal(S.findTool('pageant.exe', opts()), path.join('C:\\App', 'PuTTY', 'pageant.exe'));

  present.clear();
  present.add(path.join('C:\\Bin', 'pageant.exe'));
  assert.equal(S.findTool('pageant.exe', opts()), path.join('C:\\Bin', 'pageant.exe'));

  present.clear();
  assert.equal(S.findTool('pageant.exe', opts()), null);
});

test('executeTool reports the tool it could not find', () => {
  assert.throws(() => S.executeTool('pageant.exe', { exists: () => false, appDir: 'C:\\App', env: {} }),
    /Cannot execute 'pageant.exe'/);
});

// GUITools.cpp:572 — -pwfile only exists from PuTTY 0.77.
test('the password file is chosen only for a real putty.exe of 0.77 or newer', () => {
  assert.equal(S.usePuttyPwFile('auto', 'C:\\PuTTY\\putty.exe', { version: '0.78' }), true);
  assert.equal(S.usePuttyPwFile('auto', 'C:\\PuTTY\\putty.exe', { version: '0.77' }), true);
  assert.equal(S.usePuttyPwFile('auto', 'C:\\PuTTY\\putty.exe', { version: '0.76' }), false);
  const noVersion = { runVersion: () => ({ status: 1, stdout: '' }) };
  assert.equal(S.usePuttyPwFile('auto', 'C:\\PuTTY\\putty.exe', noVersion), false,
    'unknown version means the safe branch');
  // ...but "nobody handed me a version" is not the same as "there is none":
  // the version is read from the file, exactly as GetFileVersion does, or the
  // password would go on the command line for every PuTTY on every machine.
  assert.equal(
    S.usePuttyPwFile('auto', 'C:\\PuTTY\\putty.exe', { runVersion: () => ({ status: 0, stdout: '0.83.0.0\r\n' }) }),
    process.platform === 'win32', 'the file version is consulted when none is supplied');
  assert.equal(S.usePuttyPwFile('auto', 'C:\\Other\\kitty.exe', { version: '0.78' }), false, 'only the original exe');
  assert.equal(S.usePuttyPwFile('on', 'C:\\Other\\kitty.exe', {}), true);
  assert.equal(S.usePuttyPwFile('off', 'C:\\PuTTY\\putty.exe', { version: '0.78' }), false);
});

test('puttyArgs builds the session on the command line', () => {
  const { args } = S.puttyArgs({
    protocol: 'sftp', hostName: 'files.example.com', userName: 'martin', portNumber: 2222,
    publicKeyFile: 'C:\\keys\\id.ppk', compression: true, agentFwd: true, logicalHostName: 'real.example.com',
    addressFamily: 'ipv6',
  }, {});
  // These are argv elements, not a command line: spawn() quotes them. A literal
  // quote here would reach PuTTY as part of the file name.
  assert.deepEqual(args, [
    'files.example.com', '-l', 'martin', '-P', '2222',
    '-i', 'C:\\keys\\id.ppk', '-agent', '-A', '-C', '-2',
    '-loghost', 'real.example.com', '-6',
  ]);
});

test('a key file or user name containing a space reaches PuTTY unmangled', () => {
  const { args } = S.puttyArgs({
    protocol: 'sftp', hostName: 'h', userName: 'martin prikryl',
    publicKeyFile: 'C:\\my keys\\id.ppk',
  }, {});
  assert.equal(args[args.indexOf('-i') + 1], 'C:\\my keys\\id.ppk');
  assert.equal(args[args.indexOf('-l') + 1], 'martin prikryl');
  for (const a of args) assert.equal(a.includes('"'), false, `argv element still quoted: ${a}`);
});

test('extra parameters configured with quotes stay one argument each', () => {
  assert.deepEqual(S.splitParams('-i "C:\\my key.ppk" -X'), ['-i', 'C:\\my key.ppk', '-X']);
  assert.deepEqual(S.splitParams('   '), []);
  assert.deepEqual(S.splitParams('""'), ['']);
});

test('the default SSH port is not repeated on the command line', () => {
  const { args } = S.puttyArgs({ protocol: 'sftp', hostName: 'h', portNumber: 22 }, {});
  assert.equal(args.includes('-P'), false);
});

test('an agent that is switched off produces -noagent and no forwarding flag', () => {
  const { args } = S.puttyArgs({ protocol: 'sftp', hostName: 'h', tryAgent: false, agentFwd: true }, {});
  assert.ok(args.includes('-noagent'));
  assert.equal(args.includes('-A'), false);
  assert.equal(args.includes('-a'), false);
});

// GUITools.cpp:484 — "PuTTY does not allow -pw for telnet".
test('an FTP session opened as telnet drops the password rather than passing it', () => {
  const r = S.puttyArgs({ protocol: 'ftp', hostName: 'h', password: 'hunter2' },
    { puttyPassword: true, telnetForFtpInPutty: true });
  assert.ok(r.args.includes('-telnet'));
  assert.equal(r.password, '');
  assert.equal(r.telnet, true);
  // ...and none of the SSH-only switches are offered to telnet.
  assert.equal(r.args.includes('-2'), false);
  assert.equal(r.args.includes('-agent'), false);
});

// GUITools.cpp:442 — "Passphrase has precendence, as it's more likely entered
// by user during authentication, hence more likely really needed."
test('the passphrase takes precedence over the password', () => {
  assert.equal(S.puttyArgs({ protocol: 'sftp', hostName: 'h', password: 'pw', passphrase: 'pp' },
    { puttyPassword: true }).password, 'pp');
  assert.equal(S.puttyArgs({ protocol: 'sftp', hostName: 'h', password: 'pw' },
    { puttyPassword: true }).password, 'pw');
});

test('no password travels at all unless the preference asks for it', () => {
  assert.equal(S.puttyArgs({ protocol: 'sftp', hostName: 'h', password: 'pw' }, {}).password, '');
});

test('the password pipe hands the password over once and then closes', async () => {
  const pipeName = process.platform === 'win32'
    ? `\\\\.\\pipe\\winscp-material-test-${process.pid}-${Date.now()}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wm-pipe-')), 's');
  const pipe = await S.servePuttyPassword('hunter2', { pipeName, timeout: 5000 });
  assert.equal(pipe.pipeName, pipeName);

  const received = await new Promise((resolve, reject) => {
    const chunks = [];
    const c = net.connect(pipeName);
    c.on('data', (b) => chunks.push(b));
    c.on('end', () => resolve(Buffer.concat(chunks).toString('binary')));
    c.on('error', reject);
  });
  assert.equal(received, 'hunter2');
  pipe.close();
});

test('openSessionInPutty refuses when the program is not there', async () => {
  await assert.rejects(
    () => S.openSessionInPutty({ hostName: 'h' }, {
      puttyPath: 'C:\\Nope\\putty.exe', exists: () => false, env: {}, spawn: () => ({ unref() {} }),
    }),
    /does not exist/);
});

test('openSessionInPutty starts the program in its own directory and never logs the password', async () => {
  const program = 'C:\\PuTTY\\putty.exe';
  const calls = [];
  const r = await S.openSessionInPutty(
    { protocol: 'sftp', hostName: 'h', userName: 'u', password: 'hunter2' },
    {
      puttyPath: `"${program}"`,
      puttyPassword: true,
      usePuttyPwFile: 'off',
      exists: (p) => p === program,
      env: {},
      spawn: (cmd, args, o) => { calls.push({ cmd, args, o }); return { unref() {} }; },
    });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, program);
  assert.equal(calls[0].o.cwd, 'C:\\PuTTY');
  // The real argv carries the secret...
  assert.ok(calls[0].args.includes('hunter2'));
  // ...and the argv the caller may log does not.
  assert.equal(r.args.includes('hunter2'), false);
  assert.ok(r.args.includes('***'));
});

// ===========================================================================
// URLs — Setup.cpp:783-832
// ===========================================================================

test('a compound version renders with its release only when there is one', () => {
  assert.equal(S.versionStrFromCompoundVersion(603000000), '6.3');
  assert.equal(S.versionStrFromCompoundVersion(603040000), '6.3.4');
  assert.equal(S.versionStrFromCompoundVersion(0), '0.0');
});

test('url params append with the right separator', () => {
  assert.equal(S.appendUrlParams('https://x/y', 'a=1'), 'https://x/y?a=1');
  assert.equal(S.appendUrlParams('https://x/y?b=2', 'a=1'), 'https://x/y?b=2&a=1');
  assert.equal(S.appendUrlParams('https://x/y', ''), 'https://x/y');
});

test('campaignUrl and programUrl carry what the original carries', () => {
  assert.equal(S.campaignUrl('https://x/', { version: '6.3', medium: 'app' }),
    'https://x/?utm_source=winscp&utm_medium=app&utm_campaign=6.3');
  assert.equal(S.programUrl('https://x/', { version: '0.1.0.0', locale: '0409', installed: true }),
    'https://x/?v=0.1.0.0&lang=0409&isinstalled=1');
  assert.match(S.programUrl('https://x/', { unofficial: true }), /&unofficial=1$/);
});

// ===========================================================================
// Maintenance switches — WinMain.cpp:997-1087, UserInterface.cpp:1488
// ===========================================================================

function maintenanceIntegration() {
  const fake = fakeRegistry({ Environment: { Path: 'C:\\Windows' } });
  const integ = new S.WindowsIntegration({
    exePath: 'C:\\App\\x.exe', appName: 'App', companyKey: 'Software\\Co',
    registry: new S.Registry({ run: fake.run }),
  });
  return { fake, integ };
}

test('the installer switches dispatch to the right task', () => {
  for (const [sw, task] of [
    ['registerfordefaultprotocols', 'registerForDefaultProtocols'],
    ['registerasurlhandler', 'registerForDefaultProtocols'],   // the pre-5.x name
    ['unregisterforprotocols', 'unregisterForProtocols'],
    ['addsearchpath', 'addSearchPath'],
    ['removesearchpath', 'removeSearchPath'],
    ['uninstallcleanup', 'uninstallCleanup'],
  ]) {
    const { integ } = maintenanceIntegration();
    const r = S.maintenanceTask(new Map([[sw, { value: '' }]]), { integration: integ });
    assert.equal(r.handled, true, sw);
    assert.equal(r.task, task, sw);
    assert.equal(r.refused, undefined, sw);
  }
});

// CheckSafe: "Originally we warned when the test didn't pass, but it would
// actually be helping hackers, so let's be silent."
test('/Unsafe refuses every maintenance task, silently', () => {
  const { integ, fake } = maintenanceIntegration();
  const r = S.maintenanceTask(new Map([['registerfordefaultprotocols', {}], ['unsafe', {}]]), { integration: integ });
  assert.equal(r.handled, true);
  assert.equal(r.refused, 'unsafe');
  assert.equal(r.result, null);
  assert.equal(fake.has('Software\\Classes\\sftp'), false, 'nothing may be written for an unsafe command line');
});

test('an unknown command line is not a maintenance task', () => {
  assert.deepEqual(S.maintenanceTask(new Map([['upload', {}]]), { integration: maintenanceIntegration().integ }),
    { handled: false });
});

test('a failing maintenance task reports instead of throwing out of the launcher', () => {
  const integ = new S.WindowsIntegration({
    exePath: 'x.exe', registry: new S.Registry({ run: () => ({ status: 5, stdout: '', stderr: 'denied' }) }),
  });
  const r = S.maintenanceTask(new Map([['registerfordefaultprotocols', {}]]), { integration: integ });
  assert.equal(r.handled, true);
  assert.match(r.error, /Cannot register application/);
});

// WinMain.cpp:1004 — the silent-uninstall mutex.
test('a silent uninstall performs no cleanup and asks nothing', () => {
  const { integ, fake } = maintenanceIntegration();
  integ.registerForDefaultProtocols();
  assert.deepEqual(integ.uninstallCleanup({ silent: true }), { skipped: 'silent' });
  assert.equal(fake.has('Software\\Classes\\winscp-SFTP'), true);
});

test('an interactive uninstall unregisters the protocols and the search path', () => {
  const { integ, fake } = maintenanceIntegration();
  integ.registerForDefaultProtocols();
  integ.addSearchPath();
  const r = integ.uninstallCleanup({});
  assert.ok(r.protocols.removed.length > 0);
  assert.equal(fake.has('Software\\Classes\\winscp-SFTP'), false);
  assert.equal(new S.Registry({ run: fake.run }).read('Environment', 'Path'), 'C:\\Windows');
});

// ===========================================================================
// ============================ shellintegration =============================
// ===========================================================================

test('the drag staging directory keeps the scp????? shape', () => {
  const dir = SI.uniqDragTempDir('C:\\Temp', { exists: () => false, now: () => new Date(2026, 0, 1, 9, 3, 0, 7) });
  assert.equal(path.basename(dir), 'scp03007');
  assert.equal(SI.isFakeTransferDirectory(dir), true);
  assert.equal(SI.isFakeTransferDirectory('C:\\Temp\\other'), false);
});

test('a collision moves to the next free name inside the mask', () => {
  const taken = new Set(['scp03007']);
  const dir = SI.uniqDragTempDir('C:\\Temp', {
    exists: (p) => taken.has(path.basename(p)),
    now: () => new Date(2026, 0, 1, 9, 3, 0, 7),
  });
  assert.equal(path.basename(dir), 'scp03008');
});

// GUITools.cpp:714.
test('the DDDrives preference separates exclusions from extra paths', () => {
  assert.deepEqual(SI.parseDDDrives('-D, \\\\server\\share, -f, '),
    { excluded: ['D', 'F'], extra: ['\\\\server\\share'] });
  assert.deepEqual(SI.parseDDDrives(''), { excluded: [], extra: [] });
  assert.deepEqual(SI.parseDDDrives('-'), { excluded: [], extra: [] });
});

// CustomScpExplorer.cpp:8354 — "prefer copy for safety".
test('an ambiguous drag result resolves to copy unless the MOVE bit was set', () => {
  assert.equal(SI.dropEffectOperation('copy', SI.DROPEFFECT.MOVE), 'copy');
  assert.equal(SI.dropEffectOperation('move', SI.DROPEFFECT.COPY), 'move');
  assert.equal(SI.dropEffectOperation('invalid', SI.DROPEFFECT.NONE), 'copy');
  assert.equal(SI.dropEffectOperation('invalid', SI.DROPEFFECT.COPY), 'copy');
  assert.equal(SI.dropEffectOperation('invalid', SI.DROPEFFECT.MOVE), 'move');
  assert.equal(SI.dropEffectOperation('cancelled', SI.DROPEFFECT.MOVE), null);
});

// CustomScpExplorer.cpp:8554.
test('a move onto another session is downgraded to a copy', () => {
  assert.equal(SI.remoteDropOperation(SI.DROPEFFECT.MOVE, { ontoSessionTab: true, targetAvailable: true, sameSession: true }), 'remoteMove');
  assert.equal(SI.remoteDropOperation(SI.DROPEFFECT.MOVE, { ontoSessionTab: true, targetAvailable: true, sameSession: false }), 'remoteCopy');
  assert.equal(SI.remoteDropOperation(SI.DROPEFFECT.MOVE, { ontoSessionTab: true, targetAvailable: false }), null,
    'a disconnected session tab accepts nothing');
});

test('a drop on a remote panel follows the drop effect exactly', () => {
  assert.equal(SI.remoteDropOperation(SI.DROPEFFECT.MOVE, {}), 'remoteMove');
  assert.equal(SI.remoteDropOperation(SI.DROPEFFECT.COPY, {}), 'remoteCopy');
  assert.equal(SI.remoteDropOperation(SI.DROPEFFECT.NONE, {}), null);
  assert.equal(SI.remoteDropOperation(SI.DROPEFFECT.LINK, {}), null);
});

test('the transfer confirmation is suppressed only by the explicit off setting', () => {
  assert.equal(SI.transferConfirmationSuppressed('off'), true);
  assert.equal(SI.transferConfirmationSuppressed('auto'), false);
  assert.equal(SI.transferConfirmationSuppressed('on'), false);
  assert.equal(SI.transferConfirmationSuppressed(true), false);
  assert.equal(SI.transferConfirmationSuppressed(false), true);
  assert.equal(SI.transferConfirmationSuppressed(undefined), false);
});

// CustomScpExplorer.cpp:7097.
test('the temp-space warning fires against size times the reserve ratio', () => {
  const w = SI.warnLackOfTempSpace('C:\\Temp', 1000, { freeSpace: 1100, ratio: 1.2 });
  assert.ok(w, '1100 free is below 1000 * 1.2');
  assert.equal(w.requiredWithReserve, 1200);
  assert.match(w.message, /Too little space on temporary drive/);
  assert.equal(SI.warnLackOfTempSpace('C:\\Temp', 1000, { freeSpace: 1200, ratio: 1.2 }), null);
});

test('the temp-space warning stays quiet when it is switched off or the size is unknown', () => {
  assert.equal(SI.warnLackOfTempSpace('C:\\Temp', 1000, { freeSpace: 1, enabled: false }), null);
  // -1 is what a dragged directory sets, because its size cannot be known yet.
  assert.equal(SI.warnLackOfTempSpace('C:\\Temp', -1, { freeSpace: 1 }), null);
  assert.equal(SI.warnLackOfTempSpace('C:\\Temp', 1000, {}), null, 'no free-space figure, no guess');
});

test('the "target unknown" explanation names the mode actually in use', () => {
  assert.match(SI.targetUnknownMessage({}), /temporary folder/);
  assert.match(SI.targetUnknownMessage({ extensionInstalled: true }), /shell extension/);
});

// CustomScpExplorer.cpp:8506.
test('the staging directory is not deleted before its deadline and is retried until it goes', () => {
  let clock = 0;
  let locked = true;
  const removed = [];
  const d = new SI.DelayedDeletion({
    now: () => clock,
    remove: (p) => { if (locked) throw new Error('in use by Explorer'); removed.push(p); },
    exists: () => locked,
  });
  d.add('C:\\Temp\\scp00001', 120);

  clock = 60_000;
  assert.equal(d.run(), 1, 'still inside the delay');
  assert.deepEqual(removed, []);

  clock = 121_000;
  assert.equal(d.run(), 1, 'due, but Explorer still holds it');
  locked = false;
  assert.equal(d.run(), 0);
  assert.deepEqual(removed, ['C:\\Temp\\scp00001']);
});

test('flush attempts every queued deletion regardless of its deadline', () => {
  const removed = [];
  const d = new SI.DelayedDeletion({ now: () => 0, remove: (p) => removed.push(p), exists: () => false });
  d.add('C:\\Temp\\scp00001', 120);
  d.add('C:\\Temp\\scp00002', 120);
  assert.equal(d.flush(), 0);
  assert.equal(removed.length, 2);
});

// --------------------------------------------------------------- DragOut

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wm-drag-'));
}

test('a drag stages real files and hands their paths to the shell', async () => {
  const root = tempRoot();
  const drag = new SI.DragOut({
    tempRoot: root,
    download: async ({ items, targetDir }) => {
      for (const i of items) fs.writeFileSync(path.join(targetDir, i.localName), `contents of ${i.remoteName}`);
    },
  });
  drag.begin();
  drag.add({ name: 'report.txt', size: 120 });
  drag.add({ name: 'notes.md', size: 80 });
  assert.equal(drag.totalSize, 200);

  const staged = await drag.stage({});
  assert.equal(staged.length, 2);
  for (const p of staged) assert.ok(fs.existsSync(p), `${p} must really exist before the drag starts`);

  const dragged = [];
  drag.startDrag({ startDrag: (item) => dragged.push(item) }, { icon: fakeIcon() });
  assert.equal(dragged.length, 1);
  assert.deepEqual(dragged[0].files.sort(), staged.sort());

  const dir = drag.complete();
  assert.equal(drag.deletion.entries.length, 1);
  drag.deletion.flush();
  assert.equal(fs.existsSync(dir), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a single dragged file uses the `file` form the shell expects', async () => {
  const root = tempRoot();
  const drag = new SI.DragOut({
    tempRoot: root,
    download: async ({ items, targetDir }) => fs.writeFileSync(path.join(targetDir, items[0].localName), 'x'),
  });
  drag.begin();
  drag.add({ name: 'one.txt', size: 1 });
  await drag.stage({});
  let seen = null;
  drag.startDrag({ startDrag: (i) => { seen = i; } }, { icon: fakeIcon() });
  assert.ok(seen.file);
  assert.equal(seen.files, undefined);
  drag.abort();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a dragged directory makes the total size unknown', () => {
  const drag = new SI.DragOut({ tempRoot: os.tmpdir() });
  drag.begin();
  drag.add({ name: 'a.txt', size: 10 });
  drag.add({ name: 'folder', isDirectory: true });
  drag.add({ name: 'b.txt', size: 10 });
  assert.equal(drag.totalSize, -1, 'a directory\'s size is not known until it is walked');
  assert.equal(drag.spaceWarning({ freeSpace: 0 }), null);
  drag.abort();
});

test('a remote name Windows cannot store is renamed for the staging copy', () => {
  const drag = new SI.DragOut({ tempRoot: os.tmpdir(), copyParam: { replaceInvalidChars: true, invalidCharsReplacement: '_' } });
  drag.begin();
  const item = drag.add({ name: 'a:b*c?.txt', size: 1 });
  assert.equal(item.localName, 'a_b_c_.txt');
  assert.equal(item.remoteName, 'a:b*c?.txt', 'the remote name is untouched — that is what gets downloaded');
  drag.abort();
});

test('a preserved remote path cannot escape the temporary drag payload', () => {
  const drag = new SI.DragOut({
    tempRoot: os.tmpdir(),
    copyParam: { replaceInvalidChars: false },
  });
  drag.begin();
  assert.throws(() => drag.add({ name: '..\\outside.txt', size: 1 }), /safe local file name/);
  assert.throws(() => drag.add({ name: '/outside.txt', size: 1 }), /safe local file name/);
  drag.abort();
});

test('a drag refuses to run out of order', async () => {
  const drag = new SI.DragOut({ tempRoot: os.tmpdir() });
  assert.throws(() => drag.add({ name: 'x' }), /begin\(\) must be called/);
  drag.begin();
  await assert.rejects(() => drag.stage({}), /Nothing was dragged/);
  drag.add({ name: 'x', size: 1 });
  await assert.rejects(() => drag.stage({}), /No download function/);
  assert.deepEqual(drag.payload(), [], 'nothing is offered to the shell before it is staged');
  assert.throws(() => drag.startDrag({ startDrag() {} }, { icon: fakeIcon() }), /Nothing was staged/);
  drag.abort();
});

test('a drag needs an icon and a drag source, and says so', async () => {
  const root = tempRoot();
  const drag = new SI.DragOut({
    tempRoot: root,
    download: async ({ items, targetDir }) => fs.writeFileSync(path.join(targetDir, items[0].localName), 'x'),
  });
  drag.begin();
  drag.add({ name: 'one.txt', size: 1 });
  await drag.stage({});
  assert.throws(() => drag.startDrag(null, { icon: fakeIcon() }), /No drag source/);
  assert.throws(() => drag.startDrag({ startDrag() {} }, {}), /icon is required/);
  drag.abort();
  fs.rmSync(root, { recursive: true, force: true });
});

test('an abandoned drag removes its staging directory immediately', async () => {
  const root = tempRoot();
  const drag = new SI.DragOut({
    tempRoot: root,
    download: async ({ items, targetDir }) => fs.writeFileSync(path.join(targetDir, items[0].localName), 'x'),
  });
  const dir = drag.begin();
  drag.add({ name: 'one.txt', size: 1 });
  await drag.stage({});
  assert.equal(fs.existsSync(dir), true);
  drag.abort();
  assert.equal(fs.existsSync(dir), false, 'an abandoned drag must not leave the download behind');
  assert.equal(drag.deletion.entries.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a move drag passes the delete flag through to the transfer', async () => {
  const root = tempRoot();
  let seen = null;
  const drag = new SI.DragOut({
    tempRoot: root,
    download: async (req) => { seen = req; fs.writeFileSync(path.join(req.targetDir, req.items[0].localName), 'x'); },
  });
  drag.begin();
  drag.add({ name: 'one.txt', size: 1 });
  await drag.stage({ move: true });
  assert.equal(seen.move, true);
  assert.equal(seen.temporary, true, 'a staged download is always a temporary one');
  drag.abort();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a staging directory that cannot be created reports WinSCP\'s advice', async () => {
  const drag = new SI.DragOut({
    tempRoot: 'C:\\Temp',
    mkdir: () => { throw new Error('access denied'); },
    download: async () => undefined,
  });
  drag.begin();
  drag.add({ name: 'x', size: 1 });
  await assert.rejects(() => drag.stage({}), /change the root directory used to store temporary files/);
});

function fakeIcon() { return { isEmpty: () => false }; }

// ------------------------------------------------------------- dragging in

test('an incoming drop is classified into files, directories and things that are gone', () => {
  const stat = (p) => {
    if (p === 'C:\\gone.txt') throw new Error('ENOENT');
    if (p === 'C:\\folder') return { isDirectory: () => true, size: 0 };
    return { isDirectory: () => false, size: 100 };
  };
  const r = SI.classifyIncomingDrop(['C:\\a.txt', 'C:\\folder', 'C:\\gone.txt', ''], { stat });
  assert.deepEqual(r.files.map((f) => f.name), ['a.txt']);
  assert.deepEqual(r.directories.map((d) => d.name), ['folder']);
  assert.deepEqual(r.missing, ['C:\\gone.txt']);
  assert.equal(r.totalSize, -1, 'a directory makes the total unknowable');
  assert.equal(r.items.length, 2);
});

test('a drop of plain files reports a real total size', () => {
  const stat = () => ({ isDirectory: () => false, size: 50 });
  assert.equal(SI.classifyIncomingDrop(['a', 'b'], { stat }).totalSize, 100);
});

test('an incoming move is downgraded to a copy while move is disabled', () => {
  assert.equal(SI.incomingDropOperation(SI.DROPEFFECT.MOVE, { allowMove: true }), 'move');
  assert.equal(SI.incomingDropOperation(SI.DROPEFFECT.MOVE, { allowMove: false }), 'copy');
  assert.equal(SI.incomingDropOperation(SI.DROPEFFECT.COPY, { allowMove: true }), 'copy');
  assert.equal(SI.incomingDropOperation(SI.DROPEFFECT.NONE, { allowMove: true }), null);
  // DDDisableMove defaults to false, so an unstated preference means "allowed".
  assert.equal(SI.incomingDropOperation(SI.DROPEFFECT.MOVE, {}), 'move');
});

// WinConfiguration.cpp:534 — FDDWarnLackOfTempSpaceRatio = 1.1, not 1.2.
test('the temp-space reserve is the ratio WinSCP ships', () => {
  // 1000 * 1.1 = 1100, so 1050 free is short and 1100 free is not.
  assert.ok(SI.warnLackOfTempSpace('C:\\Temp', 1000, { freeSpace: 1050 }));
  assert.equal(SI.warnLackOfTempSpace('C:\\Temp', 1000, { freeSpace: 1100 }), null);
});

test('a drop is refused by the adapter capabilities rather than half-performed', () => {
  assert.deepEqual(SI.canAcceptDrop({ upload: true, mkdir: true }, {}), { ok: true });
  assert.equal(SI.canAcceptDrop({ upload: false }, {}).ok, false);
  assert.match(SI.canAcceptDrop({ upload: false }, {}).reason, /cannot upload/);
  assert.equal(SI.canAcceptDrop({ upload: true, mkdir: false }, { hasDirectories: true }).ok, false);
  assert.equal(SI.canAcceptDrop({ upload: true, mkdir: false }, { hasDirectories: false }).ok, true);
  assert.equal(SI.canAcceptDrop({ upload: true }, { readOnly: true }).ok, false);
});

// WinConfiguration.cpp:1824.
test('the drag extension is honestly reported as absent, and the broken Windows range is kept', () => {
  const s = SI.dragExtensionStatus({ windowsBuild: 17134 });
  assert.equal(s.installed, false);
  assert.equal(s.running, false);
  assert.equal(s.mode, 'temporary-folder');
  assert.equal(s.brokenOnThisWindows, true);
  assert.equal(SI.dragExtensionStatus({ windowsBuild: 17763 }).brokenOnThisWindows, false);
  assert.equal(SI.dragExtensionStatus({ windowsBuild: 17133 }).brokenOnThisWindows, false);
});

test('byte sizes read the way the warning quotes them', () => {
  assert.equal(SI.formatBytes(512), '512 B');
  assert.equal(SI.formatBytes(1536), '1.5 KiB');
  assert.equal(SI.formatBytes(1024 * 1024 * 3), '3.0 MiB');
});
