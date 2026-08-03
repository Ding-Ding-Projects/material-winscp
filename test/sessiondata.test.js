// sessiondata.test.js — core/SessionData.cpp + core/Option.cpp + ProgParams.cpp.
//
// These exercise design/main/sessiondata.js and design/main/options.js against
// the behaviour the C++ actually has, edge cases included: the
// defaults-vs-explicit rule that keeps an INI short, the `//` end-of-switches
// marker, the "/home/martin is a parameter" rule, the unsafe-settings polarity
// (an untrusted URL loses the dangerous option *silently*), the algorithm-list
// merge that keeps WARN in place, the empty-password marker, and the exact
// error text WinSCP reports for an invalid name or switch value.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const S = require('../design/main/sessiondata');
const O = require('../design/main/options');

/* ================================================================== */
/* core/Option.cpp — TOptions                                          */
/* ================================================================== */

test('CutToken splits on unquoted whitespace and unwraps quotes', () => {
  assert.deepStrictEqual(O.tokenizeCommandLine('a b  c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(O.tokenizeCommandLine('"a b" c'), ['a b', 'c']);
  assert.deepStrictEqual(O.tokenizeCommandLine('  \t leading'), ['leading']);
  assert.deepStrictEqual(O.tokenizeCommandLine(''), []);
  // A quote can open mid-token and the token continues after it closes.
  assert.deepStrictEqual(O.tokenizeCommandLine('c:\\"program files"\\x y'),
    ['c:\\program files\\x', 'y']);
});

test('CutToken vs CutTokenEx differ on a bare doubled quote', () => {
  // CutToken: "" is an escaped quote even outside quoting.
  assert.deepStrictEqual(O.tokenizeCommandLine('a "" b'), ['a', '"', 'b']);
  // CutTokenEx: "" outside quoting is the empty string, which is the whole
  // point of the second function existing.
  assert.deepStrictEqual(O.tokenizeCommandLine('a "" b', true), ['a', '', 'b']);
  // Inside quotes both agree that "" is one quote.
  assert.deepStrictEqual(O.tokenizeCommandLine('"a""b"', true), ['a"b']);
});

test('a token starting with a switch mark is only a switch while it looks like one', () => {
  const o = O.Options.fromArgs(['/script', '-passive', '/home/martin', '-x=1', '/2', '?']);
  // /home/martin has a '/' inside, so it is a path, not a switch.
  assert.deepStrictEqual(o.params(), ['/home/martin', '/2', '?']);
  assert.strictEqual(o.findSwitch('script'), true);
  assert.strictEqual(o.findSwitch('passive'), true);
  assert.strictEqual(o.switchValue('x'), '1');
});

test('a doubled switch mark ends switch parsing and is not itself stored', () => {
  const o = O.Options.fromArgs(['-a', '--', '-b', '/c']);
  assert.strictEqual(o.findSwitch('a'), true);
  assert.strictEqual(o.findSwitch('b'), false);
  assert.deepStrictEqual(o.params(), ['-b', '/c']);
  assert.strictEqual(o.paramCount, 2);
});

test('a long switch keeps inner dashes only when it started with two dashes', () => {
  const o = O.Options.fromArgs(['--puttygen-switches=x', '-not-a-switch']);
  // The name is taken from the second character on, so the second dash of a
  // `--switch` is part of the name — `--x` is the switch named `-x`.
  assert.strictEqual(o.switchValue('-puttygen-switches'), 'x');
  assert.strictEqual(o.findSwitch('puttygen-switches'), false);
  // With a single '-', the inner dash disqualifies it and it stays a parameter.
  assert.deepStrictEqual(o.params(), ['-not-a-switch']);
});

test('switch value delimiters are = : and the [..] array form', () => {
  const o = O.Options.fromArgs(['-a=1', '-b:2', '-c[3]', '-d']);
  assert.strictEqual(o.switchValue('a'), '1');
  assert.strictEqual(o.switchValue('b'), '2');
  assert.strictEqual(o.switchValue('c'), '3');   // the trailing ] is dropped
  assert.strictEqual(o.findSwitchValue('d').valueSet, false);
  assert.strictEqual(o.findSwitchValue('a').valueSet, true);
});

test('findSwitchParams consumes the parameters that follow, capped by the value', () => {
  const o = O.Options.fromArgs(['-rawsettings=2', 'A=1', 'B=2', 'C=3']);
  const r = o.findSwitchParams('rawsettings');
  assert.deepStrictEqual(r.params, ['A=1', 'B=2']);
  // The consumed ones are gone; the third is still a parameter.
  assert.deepStrictEqual(o.params(), ['C=3']);
  assert.strictEqual(o.paramCount, 1);
});

test('findSwitchParams is capped by paramsMax as well', () => {
  const o = O.Options.fromArgs(['-x', 'a', 'b', 'c']);
  assert.deepStrictEqual(o.findSwitchParams('x', 1).params, ['a']);
  assert.deepStrictEqual(o.params(), ['b', 'c']);
});

test('switchValueBool takes on/off and integers, and reports anything else', () => {
  const o = O.Options.fromArgs(['-a=on', '-b=off', '-c=0', '-d=7', '-e', '-f=maybe']);
  assert.strictEqual(o.switchValueBool('a', false), true);
  assert.strictEqual(o.switchValueBool('b', true), false);
  assert.strictEqual(o.switchValueBool('c', true), false);
  assert.strictEqual(o.switchValueBool('d', false), true);
  // Present but valueless falls back to the default...
  assert.strictEqual(o.switchValueBool('e', true), true);
  // ...and absent falls back to defaultOnNonExistence.
  assert.strictEqual(o.switchValueBool('missing', true, false), false);
  assert.throws(() => o.switchValueBool('f', true),
    /^Error: Invalid switch value 'maybe'\. Valid values are 'on' and 'off'\.$/);
});

test('case sensitivity: findSwitch ignores case, the CaseSensitive form does not', () => {
  const o = O.Options.fromArgs(['-Script']);
  assert.strictEqual(o.findSwitch('script'), true);
  assert.strictEqual(o.findSwitchCaseSensitive('script'), false);
  assert.strictEqual(o.findSwitchCaseSensitive('Script'), true);
});

test('unusedSwitch reports a switch nothing looked at', () => {
  const o = O.Options.fromArgs(['-known', '-typo']);
  o.findSwitch('known');
  assert.strictEqual(o.unusedSwitch(), 'typo');
  o.findSwitch('typo');
  assert.strictEqual(o.unusedSwitch(), null);
});

test('logOptions describes the command line as typed, not as consumed', () => {
  const o = O.Options.fromArgs(['-rawsettings', 'A=1']);
  o.findSwitchParams('rawsettings');           // consumes A=1
  assert.deepStrictEqual(o.logOptions(), ['Switch:    /rawsettings', 'Parameter: A=1']);
});

test('ProgramParams drops the executable from a raw command line', () => {
  const p = O.ProgramParams.fromCommandLine('"C:\\Program Files\\WinSCP\\winscp.exe" /log=x sftp://h/');
  assert.strictEqual(p.switchValue('log'), 'x');
  assert.deepStrictEqual(p.params(), ['sftp://h/']);
  assert.strictEqual(O.ProgramParams.formatSwitch('script'), '/script');
});

test('stringsToParams quotes everything but an exact integer', () => {
  assert.strictEqual(O.stringsToParams(['Timeout=42', 'Shell=/bin/sh', 'X=007']),
    ' Timeout=42 Shell="/bin/sh" X="007"');
  assert.strictEqual(O.stringsToParams(['A=say "hi"']), ' A="say ""hi"""');
});

/* ================================================================== */
/* defaults and the schema                                             */
/* ================================================================== */

test('the field set is defaults.js plus WinSCPs own extra options', () => {
  const { SESSION_DEFAULTS } = require('../design/main/defaults');
  for (const k of Object.keys(SESSION_DEFAULTS)) {
    assert.ok(k in S.SESSION_DATA_DEFAULTS, `${k} missing from the session data schema`);
  }
  for (const k of ['newPassword', 'sshBugs', 'ftpWorkFromCwd', 'isWorkspace', 'winTitle']) {
    assert.ok(k in S.SESSION_DATA_DEFAULTS, `${k} missing`);
  }
});

test('the serialization baseline uses WinSCPs factory values, not the UI ones', () => {
  const f = S.defaultSessionData();
  // These are exactly the ones that differ, and they matter because an INI
  // omits every option equal to them.
  assert.strictEqual(f.authGSSAPI, true);
  assert.strictEqual(f.sftpUploadQueue, 64);
  assert.strictEqual(f.sftpMaxVersion, -1);
  assert.strictEqual(f.recycleBinPath, '');
  assert.strictEqual(f.minTlsVersion, 'tls12');
  assert.strictEqual(f.proxyHost, 'proxy');
  assert.strictEqual(f.proxyPort, 80);
  assert.strictEqual(f.fingerprintScan, false);
  // The app template keeps defaults.js's values for a new site.
  assert.strictEqual(S.appDefaultSessionData().recycleBinPath, '/tmp');
});

/* ================================================================== */
/* save: only what differs from the default is written                 */
/* ================================================================== */

test('a session equal to the defaults writes no options at all', () => {
  assert.deepStrictEqual(S.saveSession(S.defaultSessionData()), {});
});

test('only the changed options are written', () => {
  const d = S.defaultSessionData('site');
  d.hostName = 'example.com';
  d.userName = 'martin';
  d.portNumber = 2222;
  d.compression = true;
  assert.deepStrictEqual(S.saveSession(d), {
    HostName: 'example.com', PortNumber: '2222', UserName: 'martin', Compression: '1',
  });
});

test('with no baseline every option is written — that is the raw-settings list', () => {
  const names = S.allOptionNames();
  assert.ok(names.length > 100, `expected the full option set, got ${names.length}`);
  for (const k of ['HostName', 'PortNumber', 'FSProtocol', 'Ftps', 'ProxyMethod',
    'BugHMAC2', 'SFTPSymlinkBug', 'TunnelHostName', 'MinTlsVersion', 'Utf']) {
    assert.ok(names.includes(k), `${k} missing from the option list`);
  }
});

test('PingInterval is stored split into minutes and seconds, PuTTY style', () => {
  const d = S.defaultSessionData();
  d.pingInterval = 125;
  const v = S.saveSession(d);
  assert.strictEqual(v.PingInterval, '2');
  assert.strictEqual(v.PingIntervalSecs, '5');
  const back = S.loadSession(v).data;
  assert.strictEqual(back.pingInterval, 125);
});

test('a PuTTY export writes zero ping when pings are off, because PuTTY has no off', () => {
  const d = S.defaultSessionData();
  d.pingType = 'off';
  d.pingInterval = 30;
  const v = S.exportPuttySession(d);
  assert.strictEqual(v.PingInterval, '0');
  assert.strictEqual(v.PingIntervalSecs, '0');
});

test('a PuTTY export omits our own options and duplicates the Kerberos keys', () => {
  const d = S.defaultSessionData();
  d.protocol = 'ftp';
  d.gssapiFwdTGT = true;
  d.logicalHostName = 'realm';
  const v = S.exportPuttySession(d);
  assert.ok(!('FSProtocol' in v), 'FSProtocol has no meaning to PuTTY');
  assert.ok(!('Ftps' in v));
  // Every remaining option is written: PuTTY would otherwise fall back to its
  // own defaults for anything we left out.
  assert.strictEqual(v.Compression, '0');
  assert.strictEqual(v.GSSAPIFwdTGT, '1');
  assert.strictEqual(v.SSPIFwdTGT, '1');       // Quest PuTTY's name
  assert.strictEqual(v.GssapiFwd, '1');        // official PuTTY's name
  assert.strictEqual(v.KerbPrincipal, 'realm');
  assert.strictEqual(v.Protocol, 'ssh');
});

test('the proxy command lands in the field the method selects', () => {
  const cmd = S.defaultSessionData();
  cmd.proxyMethod = 'cmd';
  cmd.proxyLocalCommand = 'nc %host %port';
  // Written raw, not munged: the command holds `%host` and `\n` verbatim.
  assert.strictEqual(S.saveSession(cmd).ProxyTelnetCommand, 'nc %host %port');
  const back = S.loadSession(S.saveSession(cmd)).data;
  assert.strictEqual(back.proxyLocalCommand, 'nc %host %port');
  // …and the default telnet command is untouched, so it is not written.
  assert.ok(!('ProxyTelnetCommand' in S.saveSession(S.defaultSessionData())));
});

test('TimeDifference is deleted rather than written when FTP detects it itself', () => {
  const d = S.defaultSessionData();
  d.protocol = 'ftp';
  d.timeDifferenceAuto = true;
  d.timeDifference = 3600;
  const storage = new S.KeyValueStorage({ TimeDifference: '0.5' });
  S.doSave(d, storage, { defaultData: S.defaultSessionData() });
  assert.ok(!('TimeDifference' in storage.values));
  // For any other protocol the value is kept, in days, as a TDateTime.
  d.protocol = 'sftp';
  assert.strictEqual(S.saveSession(d).TimeDifference, String(3600 / 86400));
});

test('bugs are stored inverted and round trip', () => {
  const d = S.defaultSessionData();
  d.sshBugs.rekey2 = 'on';
  d.sshBugs.winAdj = 'off';
  const v = S.saveSession(d);
  assert.strictEqual(v.BugRekey2, '2');   // 2 - asOn(0)
  assert.strictEqual(v.BugWinAdj, '1');   // 2 - asOff(1)
  assert.ok(!('BugHMAC2' in v), 'an auto bug equals the default and is not written');
  const back = S.loadSession(v).data;
  assert.strictEqual(back.sshBugs.rekey2, 'on');
  assert.strictEqual(back.sshBugs.winAdj, 'off');
  assert.strictEqual(back.sshBugs.hmac2, 'auto');
});

test('ProxyDNS is stored rotated so an old file keeps its meaning', () => {
  const d = S.defaultSessionData();
  d.proxyDNS = 'on';
  assert.strictEqual(S.saveSession(d).ProxyDNS, '2');
  d.proxyDNS = 'off';
  assert.strictEqual(S.saveSession(d).ProxyDNS, '0');
  assert.strictEqual(S.loadSession({ ProxyDNS: '0' }).data.proxyDNS, 'off');
  assert.strictEqual(S.loadSession({ ProxyDNS: '2' }).data.proxyDNS, 'on');
  assert.strictEqual(S.loadSession({}).data.proxyDNS, 'auto');
});

test('the site colour is stored as a Win32 BGR integer', () => {
  assert.strictEqual(S.colorToInt('#FF0000'), 0x0000FF);
  assert.strictEqual(S.intToColor(0x0000FF), '#FF0000');
  assert.strictEqual(S.colorToInt(''), 0);
  assert.strictEqual(S.intToColor(0), '');
  const d = S.defaultSessionData();
  d.color = '#123456';
  assert.strictEqual(S.loadSession(S.saveSession(d)).data.color, '#123456');
});

/* ================================================================== */
/* load                                                                */
/* ================================================================== */

test('an absent key means the default, so a load of nothing is the default session', () => {
  const loaded = S.loadSession({}).data;
  const factory = S.defaultSessionData();
  factory.source = loaded.source;
  assert.deepStrictEqual(loaded, factory);
  assert.strictEqual(loaded.source, S.SOURCE.STORED);
});

test('HostName in user@host form fills the user name, and only after UserName is read', () => {
  const d = S.loadSession({ HostName: 'martin@example.com' }).data;
  assert.strictEqual(d.hostName, 'example.com');
  assert.strictEqual(d.userName, 'martin');
  // An explicit UserName is overwritten by the one embedded in HostName,
  // because HostName is read second.
  const d2 = S.loadSession({ UserName: 'other', HostName: 'martin@example.com' }).data;
  assert.strictEqual(d2.userName, 'martin');
});

test('alias keys are read when the primary one is missing', () => {
  assert.strictEqual(S.loadSession({ AuthSSPI: '1', AuthGSSAPI: '0' }).data.authGSSAPI, false);
  assert.strictEqual(S.loadSession({ AuthSSPI: '0' }).data.authGSSAPI, false);
  assert.strictEqual(S.loadSession({ SSPIFwdTGT: '1' }).data.gssapiFwdTGT, true);
  assert.strictEqual(S.loadSession({ KerbPrincipal: 'r' }).data.logicalHostName, 'r');
  assert.strictEqual(S.loadSession({ SshSendBuf: '1024' }).data.sendBuf, 1024);
  assert.strictEqual(S.loadSession({ FtpDeleteFromCwd: '0' }).data.ftpWorkFromCwd, 'on');
});

test('an on/off word is accepted wherever an integer is', () => {
  assert.strictEqual(S.loadSession({ Compression: 'on' }).data.compression, true);
  assert.strictEqual(S.loadSession({ Compression: 'off' }).data.compression, false);
  assert.strictEqual(S.loadSession({ FtpUseMlsd: 'off' }).data.ftpUseMlsd, 'off');
  // `Utf` reads the reversed mapping: textual "on" means UTF is on, NotUtf off.
  assert.strictEqual(S.loadSession({ Utf: 'on' }).data.notUtf, 'off');
  assert.strictEqual(S.loadSession({ Utf: '0' }).data.notUtf, 'on');
});

test('a zero ping interval is corrected to 30 seconds rather than meaning never', () => {
  assert.strictEqual(S.loadSession({ PingInterval: '0', PingIntervalSecs: '0' }).data.pingInterval, 30);
});

test('the legacy BuggyMAC flag still turns the HMAC bug on', () => {
  assert.strictEqual(S.loadSession({ BuggyMAC: '1' }).data.sshBugs.hmac2, 'on');
  // But a decided BugHMAC2 wins (stored 1 is asOff, since bugs are inverted).
  assert.strictEqual(S.loadSession({ BuggyMAC: '1', BugHMAC2: '1' }).data.sshBugs.hmac2, 'off');
  // An explicit *auto* does not, because auto is what "undecided" looks like.
  assert.strictEqual(S.loadSession({ BuggyMAC: '1', BugHMAC2: '0' }).data.sshBugs.hmac2, 'on');
});

test('the legacy AliasGroupList flag chooses the other listing command', () => {
  assert.strictEqual(S.loadSession({ AliasGroupList: '1' }).data.listingCommand, 'ls -gla');
  assert.strictEqual(S.loadSession({ AliasGroupList: '1', ListingCommand: 'ls' }).data.listingCommand, 'ls');
});

test('Special is read but never written back', () => {
  assert.strictEqual(S.loadSession({ Special: '1' }).data.special, true);
  const d = S.defaultSessionData();
  d.special = true;
  // Writing it would duplicate the flag onto a copy saved under another name.
  assert.ok(!('Special' in S.saveSession(d)));
});

test('WinTitle is written for PuTTY but never read back', () => {
  const d = S.defaultSessionData();
  d.winTitle = 'a title';
  // A PuTTY store is not munged (ConfigureForPutty), so the value goes out as is.
  assert.strictEqual(S.exportPuttySession(d).WinTitle, 'a title');
  assert.ok(!('WinTitle' in S.saveSession(d)), 'it is a PuTTY-only key');
  assert.strictEqual(S.importPuttySession({ WinTitle: 'a title' }).winTitle, '');
});

test('a PuTTY import can start from the local default settings', () => {
  const defaults = S.defaultSessionData('Default Settings');
  defaults.timeout = 90;
  defaults.remoteDirectory = '/srv';
  const d = S.importPuttySession({ HostName: 'h' }, 'p', { defaultSettings: defaults });
  assert.strictEqual(d.hostName, 'h');
  assert.strictEqual(d.timeout, 90);
  assert.strictEqual(d.remoteDirectory, '/srv');
  assert.strictEqual(d.name, 'p');
});

test('an alias key is read as a plain integer, without the enum word mapping', () => {
  // The C++ nests a bare ReadEnum inside the mapped one, so only the primary
  // key understands "on"/"off"/"auto".
  assert.strictEqual(S.loadSession({ FtpWorkFromCwd: 'off' }).data.ftpWorkFromCwd, 'off');
  assert.strictEqual(S.loadSession({ FtpDeleteFromCwd: 'off' }).data.ftpWorkFromCwd, 'auto');
  assert.strictEqual(S.loadSession({ FtpDeleteFromCwd: '1' }).data.ftpWorkFromCwd, 'off');
});

test('a plain password is read and flagged for rewriting into the protected form', () => {
  const r = S.loadSession({ PasswordPlain: 'secret' });
  assert.strictEqual(r.data.password, 'secret');
  assert.strictEqual(r.rewritePassword, true);
  const r2 = S.loadSession({ Password: 'stored' });
  assert.strictEqual(r2.rewritePassword, false);
  // Passwords can be refused entirely (DisablePasswordStoring).
  assert.strictEqual(S.loadSession({ PasswordPlain: 'x' }, { loadPasswords: false }).data.password, '');
});

test('raw string options stay strings when an importer supplies typed values', () => {
  const d = S.loadSession({ ProxyTelnetCommand: 123 }).data;
  assert.strictEqual(d.proxyTelnetCommand, '123');
  assert.strictEqual(typeof d.proxyTelnetCommand, 'string');
});

test('loadPasswords false does not load any session secret', () => {
  const r = S.loadSession({
    PasswordPlain: 'main',
    ProxyPassword: 'proxy',
    ProxyPasswordEnc: 'proxy-encrypted',
    TunnelPasswordPlain: 'tunnel',
    TunnelPassphrasePlain: 'passphrase',
    EncryptKeyPlain: 'encrypt',
  }, { loadPasswords: false });
  assert.strictEqual(r.data.password, '');
  assert.strictEqual(r.data.proxyPassword, '');
  assert.strictEqual(r.data.tunnelPassword, '');
  assert.strictEqual(r.data.tunnelPassphrase, '');
  assert.strictEqual(r.data.encryptKey, '');
  assert.strictEqual(r.rewritePassword, false);
});

test('writing one password form deletes the other', () => {
  const d = S.defaultSessionData();
  d.password = 'p';
  const storage = new S.KeyValueStorage({ Password: 'old-encrypted' });
  S.doSave(d, storage, { defaultData: S.defaultSessionData() });
  assert.strictEqual(storage.values.PasswordPlain, 'p');
  assert.ok(!('Password' in storage.values));
  // And clearing it removes both.
  d.password = '';
  const storage2 = new S.KeyValueStorage({ Password: 'x', PasswordPlain: 'y' });
  S.doSave(d, storage2, { defaultData: S.defaultSessionData() });
  assert.ok(!('Password' in storage2.values) && !('PasswordPlain' in storage2.values));
});

/* ================================================================== */
/* munging: how a value survives an INI line                           */
/* ================================================================== */

test('a value with spaces, equals signs or non-ASCII survives an INI round trip', () => {
  for (const v of ['ls -la', 'a=b', 'héllo wörld', '100%', 'C:\\path\\file', '*.txt', '']) {
    assert.strictEqual(S.unMungeStr(S.mungeStr(v)), v, `round trip failed for ${JSON.stringify(v)}`);
  }
  // Space and backslash are escaped; the masked password keeps its stars.
  assert.strictEqual(S.mungeStr('a b'), 'a%20b');
  assert.strictEqual(S.mungeStr('***'), '***');
  // Non-ASCII gets a BOM so an old reader can tell the encoding.
  assert.ok(S.mungeStr('é').startsWith('%EF%BB%BF'));
});

test('an INI key is escaped only when it is not plain ASCII', () => {
  assert.strictEqual(S.mungeIniName('HostName'), 'HostName');
  assert.ok(S.mungeIniName('kèy').startsWith('%EF%BB%BF'));
  // PuTTY's escaper leaves '=' alone, so an ASCII name comes back unchanged
  // even though it triggered the check — matching the C++ exactly.
  assert.strictEqual(S.mungeIniName('a=b'), 'a=b');
  // The reader still understands the older '%3D' spelling.
  assert.strictEqual(S.unMungeIniName('a%3Db'), 'a=b');
  assert.strictEqual(S.unMungeIniName('HostName'), 'HostName');
});

test('keys are matched case-insensitively, like a TIniFile and a TStringList', () => {
  assert.strictEqual(S.loadSession({ hostname: 'h' }).data.hostName, 'h');
  assert.strictEqual(S.loadSession({ TIMEOUT: '9' }).data.timeout, 9);
});

test('blank floating-point values keep the supplied default', () => {
  const storage = new S.KeyValueStorage({ PingInterval: '' });
  assert.strictEqual(storage.readFloat('PingInterval', 17.5), 17.5);
  assert.strictEqual(storage.readFloat('PingInterval', 0), 0);
});

test('case-variant duplicate storage keys keep the last value without re-exporting the shadowed key', () => {
  const storage = new S.KeyValueStorage({ HostName: 'old', hostname: 'new' });
  assert.strictEqual(storage.readString('HostName', ''), 'new');
  assert.deepStrictEqual(storage.toLines(), ['hostname=new']);
  storage.writeString('HOSTNAME', 'latest');
  assert.deepStrictEqual(storage.toLines(), ['hostname=latest']);
});

/* ================================================================== */
/* raw settings                                                        */
/* ================================================================== */

test('raw settings are Name=Value lines and apply over the current values', () => {
  const d = S.defaultSessionData();
  d.timeout = 5;
  S.applyRawSettings(d, ['Timeout=42', 'Compression=1']);
  assert.strictEqual(d.timeout, 42);
  assert.strictEqual(d.compression, true);
  // Everything not named is left alone — this is an override, not a load.
  assert.strictEqual(d.portNumber, 22);
});

test('the raw-settings text format ignores blanks, comments and lines with no =', () => {
  assert.deepStrictEqual(
    S.parseRawSettingsText('Timeout=42\n\n; a comment\n# another\nnonsense\nShell=/bin/sh\n'),
    ['Timeout=42', 'Shell=/bin/sh']);
  assert.strictEqual(S.formatRawSettingsText(['A=1', 'B=2']), 'A=1\r\nB=2');
});

test('a raw setting may carry the session name', () => {
  const d = S.defaultSessionData('old');
  S.applyRawSettings(d, ['Name=new'], { loadName: true });
  assert.strictEqual(d.name, 'new');
  const d2 = S.defaultSessionData('old');
  S.applyRawSettings(d2, ['Name=new']);
  assert.strictEqual(d2.name, 'old');
});

test('an untrusted source loses an unsafe option silently; a trusted one flags it', () => {
  const untrusted = S.defaultSessionData();
  const r1 = S.applyRawSettings(untrusted, ['Shell=/bin/evil', 'Timeout=9'], { unsafe: true });
  assert.strictEqual(untrusted.shell, '', 'an unsafe option must not be applied');
  assert.strictEqual(untrusted.timeout, 9, 'a safe option still applies');
  assert.strictEqual(r1.unsafeSettings, false, 'and the refusal is silent');

  const trusted = S.defaultSessionData();
  const r2 = S.applyRawSettings(trusted, ['Shell=/bin/evil']);
  assert.strictEqual(trusted.shell, '/bin/evil');
  assert.strictEqual(r2.unsafeSettings, true);
  assert.ok(r2.parsedInfo & S.PI.UNSAFE_SETTINGS);
});

test('an unsafe option set to its existing value does not raise the warning', () => {
  const d = S.defaultSessionData();
  const r = S.applyRawSettings(d, ['RecycleBinPath=']);
  assert.strictEqual(r.unsafeSettings, false);
});

test('every unsafe option is one that runs a command or relaxes a check', () => {
  const unsafeKeys = S.OPTIONS.filter((o) => o.unsafe).map((o) => o.k).sort();
  assert.deepStrictEqual(unsafeKeys, [
    'DeleteToRecycleBin', 'GSSLibs', 'ListingCommand', 'OverwrittenToRecycleBin',
    'PostLoginCommands', 'RecycleBinPath', 'ReturnVar', 'SftpServer', 'Shell',
    'WebDavCrossDomainRedirects', 'WebDavUnencryptedRedirects',
  ]);
});

/* ================================================================== */
/* algorithm lists                                                     */
/* ================================================================== */

test('an unlisted algorithm is merged back in, and WARN keeps its place', () => {
  // arcfour promoted to the front: everything the factory prefers above the
  // WARN marker comes back before it, everything below stays below.
  assert.deepStrictEqual(
    S.setAlgoList(S.DEFAULT_CIPHER_LIST, S.CIPHER_NAMES, 'WARN', 'arcfour,aes'),
    ['arcfour', 'aes', 'chacha20', 'aesgcm', '3des', 'WARN', 'des', 'blowfish']);
  // An empty list is the factory order.
  assert.deepStrictEqual(
    S.setAlgoList(S.DEFAULT_CIPHER_LIST, S.CIPHER_NAMES, 'WARN', ''), S.DEFAULT_CIPHER_LIST);
  // Unknown and duplicate names are skipped rather than corrupting the list.
  assert.deepStrictEqual(
    S.setAlgoList(S.DEFAULT_CIPHER_LIST, S.CIPHER_NAMES, 'WARN', 'aes,aes,nonsense'),
    S.DEFAULT_CIPHER_LIST);
  // A list with no WARN gets one appended before the merge.
  const noWarn = S.setAlgoList(S.DEFAULT_CIPHER_LIST, S.CIPHER_NAMES, 'WARN', 'des');
  assert.strictEqual(noWarn.length, S.CIPHER_NAMES.length);
  assert.ok(noWarn.includes('WARN'));
});

test('a list with no WARN marker at all (GSS libraries) still merges', () => {
  // 'custom' is the only entry the file names, but gssapi32 and sspi are both
  // prioritised above it in the factory order, so they are merged in front —
  // that is the "priority" half of the merge.
  assert.deepStrictEqual(
    S.setAlgoList(S.DEFAULT_GSSLIB_LIST, S.GSSLIB_NAMES, null, 'custom'),
    ['gssapi32', 'sspi', 'custom']);
  // Reordering the head keeps the user's choice at the front.
  assert.deepStrictEqual(
    S.setAlgoList(S.DEFAULT_GSSLIB_LIST, S.GSSLIB_NAMES, null, 'sspi'),
    ['gssapi32', 'sspi', 'custom']);
});

test('the cipher list round trips through the INI as a comma-separated string', () => {
  const d = S.defaultSessionData();
  d.cipherList = S.setAlgoList(S.DEFAULT_CIPHER_LIST, S.CIPHER_NAMES, 'WARN', 'arcfour');
  const v = S.saveSession(d);
  assert.strictEqual(v.Cipher, d.cipherList.join(','));
  assert.deepStrictEqual(S.loadSession(v).data.cipherList, d.cipherList);
});

/* ================================================================== */
/* naming, ports and validation                                        */
/* ================================================================== */

test('defaultPort covers every protocol and encryption combination', () => {
  assert.strictEqual(S.defaultPort('sftp'), 22);
  assert.strictEqual(S.defaultPort('sftpOnly'), 22);
  assert.strictEqual(S.defaultPort('scp'), 22);
  assert.strictEqual(S.defaultPort('ftp', 'none'), 21);
  assert.strictEqual(S.defaultPort('ftp', 'explicitTls'), 21);
  assert.strictEqual(S.defaultPort('ftp', 'implicit'), 990);
  assert.strictEqual(S.defaultPort('webdav', 'none'), 80);
  assert.strictEqual(S.defaultPort('webdav', 'implicit'), 443);
  assert.strictEqual(S.defaultPort('s3', 'none'), 80);
  assert.strictEqual(S.defaultPort('s3', 'implicit'), 443);
});

test('a session is secure over SSH, or over anything with TLS', () => {
  const d = S.defaultSessionData();
  assert.strictEqual(S.isSecure({ ...d, protocol: 'scp' }), true);
  assert.strictEqual(S.isSecure({ ...d, protocol: 'ftp', ftps: 'none' }), false);
  assert.strictEqual(S.isSecure({ ...d, protocol: 'ftp', ftps: 'explicitTls' }), true);
  assert.strictEqual(S.isSecure({ ...d, protocol: 'webdav', ftps: 'implicit' }), true);
});

test('the default session name is user@host, the host alone, or "session"', () => {
  const d = S.defaultSessionData();
  assert.strictEqual(S.defaultSessionName(d), 'session');
  assert.strictEqual(S.defaultSessionName({ ...d, hostName: 'h' }), 'h');
  assert.strictEqual(S.defaultSessionName({ ...d, hostName: 'h', userName: 'u' }), 'u@h');
  // A slash cannot appear in a name, so a user name containing one is folded.
  assert.strictEqual(S.defaultSessionName({ ...d, hostName: 'h', userName: 'a/b' }), 'a\\b@h');
  // Two local directories mean the local browser, named after both.
  assert.strictEqual(
    S.defaultSessionName({ ...d, localDirectory: 'C:\\a\\one', otherLocalDirectory: 'C:\\b\\two' }),
    'one – two');
});

test('the hidden prefix and the reserved default name do not count as a session name', () => {
  assert.strictEqual(S.hasSessionName(S.defaultSessionData('site')), true);
  assert.strictEqual(S.hasSessionName(S.defaultSessionData('_!_')), false);
  assert.strictEqual(S.hasSessionName(S.defaultSessionData('Default Settings')), false);
  assert.strictEqual(S.sessionName(S.defaultSessionData('_!_hidden')), 'hidden');
});

test('a name may not contain a slash, and the error says so exactly', () => {
  assert.throws(() => S.validateName('a/b'),
    /^Error: Invalid name 'a\/b'\. Name cannot contain '\/'\.$/);
  assert.doesNotThrow(() => S.validateName('a\\b'));
  assert.strictEqual(S.makeValidName('a/b/c'), 'a\\b\\c');
});

test('folder and local names split on the last slash', () => {
  const d = S.defaultSessionData('work/eu/prod');
  assert.strictEqual(S.folderName(d), 'work/eu');
  assert.strictEqual(S.localName(d), 'prod');
  assert.strictEqual(S.composePath('work/eu', 'prod'), 'work/eu/prod');
  assert.strictEqual(S.composePath('', 'prod'), 'prod');
  assert.strictEqual(S.extractFolderName('top'), '');
});

test('the session key drops the port only when it is the protocol default', () => {
  const d = S.defaultSessionData();
  d.hostName = 'h'; d.userName = 'u';
  assert.strictEqual(S.sessionKey(d), 'u@h');
  d.portNumber = 2222;
  assert.strictEqual(S.sessionKey(d), 'u@h:2222');
  assert.strictEqual(S.siteKey(d), 'h:2222');
  assert.strictEqual(S.formatSiteKey('h', 22), 'h:22');
});

test('sftpOnly and sftp are the same site', () => {
  const a = { ...S.defaultSessionData(), protocol: 'sftp', hostName: 'h', portNumber: 22, userName: 'u' };
  const b = { ...a, protocol: 'sftpOnly' };
  assert.strictEqual(S.isSameSite(a, b), true);
  assert.strictEqual(S.isSameSite(a, { ...a, portNumber: 23 }), false);
});

test('isSame can collect every difference instead of stopping at the first', () => {
  const a = S.defaultSessionData();
  const b = S.defaultSessionData();
  b.hostName = 'h';
  b.compression = true;
  const diff = [];
  assert.strictEqual(S.isSame(a, b, { differentProperties: diff }), false);
  assert.deepStrictEqual(diff.sort(), ['compression', 'hostName']);
  // advancedOnly ignores the core identity of the site.
  assert.strictEqual(S.isSame(a, { ...a, hostName: 'x' }, { advancedOnly: true }), true);
});

/* ================================================================== */
/* IPv6                                                                */
/* ================================================================== */

test('an IPv6 literal needs hex digits and at least two colons', () => {
  assert.strictEqual(S.isIPv6Literal('::1'), true);
  assert.strictEqual(S.isIPv6Literal('2001:db8::1'), true);
  assert.strictEqual(S.isIPv6Literal('[2001:db8::1]'), true);
  assert.strictEqual(S.isIPv6Literal('fe80::1%eth0'), true);   // a zone index is accepted
  assert.strictEqual(S.isIPv6Literal('example.com'), false);
  assert.strictEqual(S.isIPv6Literal('1:2'), false);           // one colon is a host:port
  assert.strictEqual(S.escapeIPv6Literal('::1'), '[::1]');
  assert.strictEqual(S.escapeIPv6Literal('[::1]'), '[::1]');
  assert.strictEqual(S.stripIP6LiteralBrackets('[::1]'), '::1');
});

/* ================================================================== */
/* URL generation                                                      */
/* ================================================================== */

test('the URL scheme reflects protocol and encryption', () => {
  const u = (protocol, ftps, http) =>
    S.protocolUrl({ ...S.defaultSessionData(), protocol, ftps }, http);
  assert.strictEqual(u('scp'), 'scp://');
  assert.strictEqual(u('sftp'), 'sftp://');
  assert.strictEqual(u('sftpOnly'), 'sftp://');
  assert.strictEqual(u('ftp', 'none'), 'ftp://');
  assert.strictEqual(u('ftp', 'implicit'), 'ftps://');
  assert.strictEqual(u('ftp', 'explicitTls'), 'ftpes://');
  assert.strictEqual(u('ftp', 'explicitSsl'), 'ftpes://');
  assert.strictEqual(u('webdav', 'none'), 'dav://');
  assert.strictEqual(u('webdav', 'implicit'), 'davs://');
  assert.strictEqual(u('webdav', 'none', true), 'http://');
  assert.strictEqual(u('webdav', 'implicit', true), 'https://');
  assert.strictEqual(u('s3', 'implicit'), 's3://');
  assert.strictEqual(u('s3', 'none'), 's3plain://');
});

test('a generated URL carries the port only when it is not the default', () => {
  const d = S.defaultSessionData();
  d.hostName = 'example.com'; d.userName = 'martin';
  assert.strictEqual(S.generateSessionUrl(d, S.SUF.USERNAME), 'sftp://martin@example.com/');
  d.portNumber = 2222;
  assert.strictEqual(S.generateSessionUrl(d, S.SUF.USERNAME), 'sftp://martin@example.com:2222/');
});

test('an IPv6 host is bracketed rather than percent-encoded', () => {
  const d = S.defaultSessionData();
  d.hostName = '2001:db8::1';
  assert.strictEqual(S.generateSessionUrl(d, 0), 'sftp://[2001:db8::1]/');
});

test('the password is only in the URL when it is asked for', () => {
  const d = S.defaultSessionData();
  d.hostName = 'h'; d.userName = 'u'; d.password = 'p@ss word';
  assert.strictEqual(S.generateSessionUrl(d, S.SUF.USERNAME), 'sftp://u@h/');
  assert.strictEqual(S.generateSessionUrl(d, S.SUF.USERNAME | S.SUF.PASSWORD),
    'sftp://u:p%40ss%20word@h/');
  // maskPasswords first, and the URL is safe to show.
  assert.strictEqual(S.generateSessionUrl(S.maskPasswords(S.cloneSessionData(d)),
    S.SUF.USERNAME | S.SUF.PASSWORD), 'sftp://u:***@h/');
});

test('a host key becomes a ;fingerprint= parameter, algorithm name included', () => {
  const d = S.defaultSessionData();
  d.hostName = 'h'; d.userName = 'u';
  d.hostKey = 'ssh-ed25519 255 SHA256:abc+def/ghi=';
  const url = S.generateSessionUrl(d, S.SUF.USERNAME | S.SUF.HOSTKEY);
  assert.strictEqual(url, 'sftp://u;fingerprint=ssh-ed25519-SHA256-abc-def_ghi@h/');
  // A TLS fingerprint has no algorithm prefix; only its colons change.
  d.hostKey = 'aa:bb:cc';
  assert.strictEqual(S.generateSessionUrl(d, S.SUF.USERNAME | S.SUF.HOSTKEY),
    'sftp://u;fingerprint=aa-bb-cc@h/');
});

test('raw settings for a URL exclude what the URL itself says and per-machine state', () => {
  const d = S.defaultSessionData('site');
  d.hostName = 'h'; d.userName = 'u'; d.password = 'p'; d.portNumber = 2222;
  d.protocol = 'ftp'; d.ftps = 'implicit'; d.hostKey = 'x';
  d.localDirectory = 'C:\\tmp'; d.color = '#FF0000'; d.note = 'a note';
  d.compression = true;
  const raw = S.getRawSettingsForUrl(d);
  assert.deepStrictEqual(raw, ['Name=site', 'Compression=1']);
  assert.strictEqual(S.hasRawSettingsForUrl(d), true);
  assert.strictEqual(S.hasRawSettingsForUrl(S.defaultSessionData()), false);
});

test('a URL with raw settings round trips back into the same session', () => {
  const d = S.defaultSessionData('');
  d.hostName = 'example.com'; d.userName = 'martin'; d.portNumber = 21;
  d.protocol = 'ftp'; d.ftps = 'explicitTls';
  d.timeout = 42; d.listingCommand = 'ls -gla'; d.postLoginCommands = ['pwd', 'ls'];
  d.sftpBugs.symlink = 'off';
  const url = S.generateSessionUrl(d, S.SUF.COMPLETE);
  const back = S.parseUrl(url).data;
  assert.strictEqual(back.protocol, 'ftp');
  assert.strictEqual(back.ftps, 'explicitTls');
  assert.strictEqual(back.timeout, 42);
  assert.strictEqual(back.listingCommand, 'ls -gla');
  assert.deepStrictEqual(back.postLoginCommands, ['pwd', 'ls']);
  assert.strictEqual(back.sftpBugs.symlink, 'off');
});

test('the winscp- prefix is added for a URL that must reach this application', () => {
  const d = S.defaultSessionData();
  d.hostName = 'h';
  assert.strictEqual(S.generateSessionUrl(d, S.SUF.SPECIFIC), 'winscp-sftp://h/');
});

/* ================================================================== */
/* URL parsing                                                         */
/* ================================================================== */

test('every protocol prefix is recognised, with and without the winscp- prefix', () => {
  const p = (url) => {
    const r = S.parseUrl(url);
    return [r.data.protocol, r.data.ftps, r.data.portNumber];
  };
  assert.deepStrictEqual(p('scp://h/'), ['scp', 'none', 22]);
  assert.deepStrictEqual(p('sftp://h/'), ['sftpOnly', 'none', 22]);
  assert.deepStrictEqual(p('ssh://h/'), ['sftpOnly', 'none', 22]);
  assert.deepStrictEqual(p('ftp://h/'), ['ftp', 'none', 21]);
  assert.deepStrictEqual(p('ftps://h/'), ['ftp', 'implicit', 990]);
  assert.deepStrictEqual(p('ftpes://h/'), ['ftp', 'explicitTls', 21]);
  assert.deepStrictEqual(p('dav://h/'), ['webdav', 'none', 80]);
  assert.deepStrictEqual(p('davs://h/'), ['webdav', 'implicit', 443]);
  assert.deepStrictEqual(p('s3plain://h/'), ['s3', 'none', 80]);
  assert.deepStrictEqual(p('winscp-sftp://h/'), ['sftpOnly', 'none', 22]);
  assert.deepStrictEqual(p('SFTP://h/'), ['sftpOnly', 'none', 22]);
});

test('http and https mean WebDAV by default and S3 when the site already is S3', () => {
  assert.strictEqual(S.parseUrl('https://h/').data.protocol, 'webdav');
  const s3 = S.defaultSessionData();
  s3.protocol = 's3';
  const r = S.parseUrl('https://h/', { data: s3, flags: S.PUF.PREFER_PROTOCOL });
  assert.strictEqual(r.data.protocol, 's3');
});

test('a WebDAV URL pointing at a known object store is really S3', () => {
  for (const host of ['bucket.s3.amazonaws.com', 'x.digitaloceanspaces.com',
    'storage.googleapis.com', 'x.r2.cloudflarestorage.com',
    'ns.compat.objectstorage.eu.oraclecloud.com']) {
    assert.strictEqual(S.parseUrl(`https://${host}/`).data.protocol, 's3', host);
  }
  assert.strictEqual(S.parseUrl('https://example.com/').data.protocol, 'webdav');
});

test('credentials, port, path and file name are pulled out of a URL', () => {
  const r = S.parseUrl('sftp://martin:secret@example.com:2222/home/martin/file.txt',
    { wantFileName: true });
  assert.strictEqual(r.data.userName, 'martin');
  assert.strictEqual(r.data.password, 'secret');
  assert.strictEqual(r.data.hostName, 'example.com');
  assert.strictEqual(r.data.portNumber, 2222);
  assert.strictEqual(r.data.remoteDirectory, '/home/martin/');
  assert.strictEqual(r.fileName, 'file.txt');
  assert.ok(r.parsedInfo & S.PI.PROTOCOL_DEFINED);
});

test('a trailing slash means the whole URL is a directory, not a file', () => {
  const r = S.parseUrl('sftp://h/home/martin/', { wantFileName: true });
  assert.strictEqual(r.data.remoteDirectory, '/home/martin/');
  assert.strictEqual(r.fileName, '');
});

test('percent escapes and plus signs are decoded in every part of a URL', () => {
  const r = S.parseUrl('sftp://user%40domain:p%40ss@h/a%20dir/');
  assert.strictEqual(r.data.userName, 'user@domain');
  assert.strictEqual(r.data.password, 'p@ss');
  assert.strictEqual(r.data.remoteDirectory, '/a dir/');
});

test('an IPv6 literal in a URL is read out of its brackets, port and all', () => {
  const r = S.parseUrl('sftp://u@[2001:db8::1]:2222/');
  assert.strictEqual(r.data.hostName, '2001:db8::1');
  assert.strictEqual(r.data.portNumber, 2222);
  const r2 = S.parseUrl('sftp://[::1]/');
  assert.strictEqual(r2.data.hostName, '::1');
  assert.strictEqual(r2.data.portNumber, 22);
});

test('the last @ separates the credentials, so a password may contain one', () => {
  const r = S.parseUrl('ftp://user:p@ss@example.com/');
  assert.strictEqual(r.data.userName, 'user');
  assert.strictEqual(r.data.password, 'p@ss');
  assert.strictEqual(r.data.hostName, 'example.com');
});

test('an explicitly empty password is not the same as no password', () => {
  // Both end up empty on the way out, but only the second one has a password
  // at all — the marker exists so the caller does not prompt for one.
  assert.strictEqual(S.parseUrl('sftp://u@h/').data.password, '');
  assert.strictEqual(S.parseUrl('sftp://u:@h/').data.password, '');
  assert.strictEqual(S.parseUrl('sftp://u:x@h/').data.password, 'x');
});

test('an out-of-range port is ignored rather than accepted', () => {
  assert.strictEqual(S.parseUrl('sftp://h:70000/').data.portNumber, 22);
  assert.strictEqual(S.parseUrl('sftp://h:0/').data.portNumber, 22);
  assert.strictEqual(S.parseUrl('sftp://h:abc/').data.portNumber, 22);
});

test('the masked URL replaces the password and nothing else', () => {
  const r = S.parseUrl('sftp://martin:secret@example.com:2222/home/');
  assert.strictEqual(r.maskedUrl, 'sftp://martin:***@example.com:2222/home/');
  assert.ok(!r.maskedUrl.includes('secret'));
  // With no password there is nothing to mask and no stray colon.
  assert.strictEqual(S.parseUrl('sftp://martin@example.com/').maskedUrl,
    'sftp://martin@example.com/');
  assert.strictEqual(S.parseUrl('sftp://example.com/').maskedUrl, 'sftp://example.com/');
});

test('an empty URL is defaults only', () => {
  const r = S.parseUrl('');
  assert.ok(r.parsedInfo & S.PI.DEFAULTS_ONLY);
  assert.ok(!(r.parsedInfo & S.PI.PROTOCOL_DEFINED));
});

test('a ;save= parameter is read off the path, not the credentials', () => {
  assert.strictEqual(S.parseUrl('sftp://h/;save').data.saveOnly, true);
  assert.strictEqual(S.parseUrl('sftp://h/;save=1').data.saveOnly, true);
  assert.strictEqual(S.parseUrl('sftp://h/;save=0').data.saveOnly, false);
  assert.strictEqual(S.parseUrl('sftp://h/').data.saveOnly, false);
});

test('a ;fingerprint= parameter does not override the cached host key', () => {
  const r = S.parseUrl('sftp://u;fingerprint=ssh-rsa-SHA256-abc@h/');
  assert.strictEqual(r.data.hostKey, 'ssh-rsa-SHA256-abc');
  assert.strictEqual(r.data.overrideCachedHostKey, false);
  // Whereas the -hostkey switch is a deliberate override.
  const r2 = S.parseUrl('sftp://h/', { options: ['-hostkey=abc'] });
  assert.strictEqual(r2.data.hostKey, 'abc');
  assert.strictEqual(r2.data.overrideCachedHostKey, true);
});

test('an x- parameter with an empty value removes the setting rather than blanking it', () => {
  // TStrings.Values semantics: assigning '' deletes the name.
  const r = S.parseUrl('sftp://u;x-timeout=9;x-timeout=@h/');
  assert.strictEqual(r.data.timeout, 15, 'the setting should have been dropped entirely');
});

test('a stored site can be named in place of a host, with a path after it', () => {
  const stored = S.defaultSessionData('work/prod');
  stored.hostName = 'prod.example.com';
  stored.userName = 'deploy';
  stored.portNumber = 2200;
  const sessions = { sessions: [stored], defaultSettings: S.defaultSessionData() };

  const r = S.parseUrl('work/prod', { storedSessions: sessions });
  assert.strictEqual(r.data.hostName, 'prod.example.com');
  assert.strictEqual(r.data.userName, 'deploy');
  assert.strictEqual(r.data.portNumber, 2200);

  const r2 = S.parseUrl('work/prod/var/log/', { storedSessions: sessions });
  assert.strictEqual(r2.data.hostName, 'prod.example.com');
  assert.strictEqual(r2.data.remoteDirectory, '/var/log/');
  assert.strictEqual(r2.data.requireDirectories, true);
});

test('a stored site keeps save session parameters out of its remote path', () => {
  const stored = S.defaultSessionData('work/prod');
  stored.hostName = 'prod.example.com';
  const sessions = { sessions: [stored], defaultSettings: S.defaultSessionData() };

  const r = S.parseUrl('work/prod/var/log/;save=1', { storedSessions: sessions });
  assert.strictEqual(r.data.saveOnly, true);
  assert.strictEqual(r.data.remoteDirectory, '/var/log/');
});

test('a stored site is only matched under a protocol when the caller allows it', () => {
  const stored = S.defaultSessionData('example.com');
  stored.hostName = 'real.example.com';
  const sessions = { sessions: [stored], defaultSettings: S.defaultSessionData() };
  assert.strictEqual(S.parseUrl('sftp://example.com/', { storedSessions: sessions }).data.hostName,
    'example.com');
  assert.strictEqual(
    S.parseUrl('sftp://example.com/', {
      storedSessions: sessions, flags: S.PUF.ALLOW_STORED_SITE_WITH_PROTOCOL,
    }).data.hostName, 'real.example.com');
});

test('a workspace entry is never matched as a site name', () => {
  const ws = S.defaultSessionData('0001');
  ws.isWorkspace = true;
  ws.hostName = 'should-not-be-used';
  const r = S.parseUrl('0001', { storedSessions: { sessions: [ws], defaultSettings: S.defaultSessionData() } });
  assert.strictEqual(r.data.hostName, '0001');
});

/* ================================================================== */
/* command-line switches applied to a session                          */
/* ================================================================== */

test('the session switches override what the URL said', () => {
  const r = S.parseUrl('sftp://urluser@h/', {
    options: ['-username=cmduser', '-password=pw', '-privatekey=key.ppk',
      '-clientcert=c.pem', '-passphrase=pp', '-timeout=99', '-SessionName=named'],
  });
  assert.strictEqual(r.data.userName, 'cmduser');
  assert.strictEqual(r.data.password, 'pw');
  assert.strictEqual(r.data.publicKeyFile, 'key.ppk');
  assert.strictEqual(r.data.tlsCertificateFile, 'c.pem');
  assert.strictEqual(r.data.passphrase, 'pp');
  assert.strictEqual(r.data.timeout, 99);
  assert.strictEqual(r.data.name, 'named');
});

test('-newpassword also turns the change-password flag on', () => {
  const r = S.parseUrl('sftp://h/', { options: ['-newpassword=new'] });
  assert.strictEqual(r.data.newPassword, 'new');
  assert.strictEqual(r.data.changePassword, true);
});

test('-implicit and -explicit set the encryption and the matching default port', () => {
  let r = S.parseUrl('ftp://h/', { options: ['-implicit'] });
  assert.strictEqual(r.data.ftps, 'implicit');
  assert.strictEqual(r.data.portNumber, 990);
  r = S.parseUrl('ftp://h/', { options: ['-explicit'] });
  assert.strictEqual(r.data.ftps, 'explicitTls');
  assert.strictEqual(r.data.portNumber, 21);
  // 5.5.x spelling, still accepted.
  r = S.parseUrl('ftp://h/', { options: ['-explicitssl'] });
  assert.strictEqual(r.data.ftps, 'explicitSsl');
  // An explicit port in the URL is not overwritten.
  r = S.parseUrl('ftp://h:8021/', { options: ['-implicit'] });
  assert.strictEqual(r.data.portNumber, 8021);
  // And it can be turned off again.
  r = S.parseUrl('ftps://h/', { options: ['-implicit=off'] });
  assert.strictEqual(r.data.ftps, 'none');
});

test('-passive takes on/off and defaults to the current value', () => {
  assert.strictEqual(S.parseUrl('ftp://h/', { options: ['-passive=off'] }).data.ftpPasvMode, false);
  assert.strictEqual(S.parseUrl('ftp://h/', { options: ['-passive=on'] }).data.ftpPasvMode, true);
  assert.strictEqual(S.parseUrl('ftp://h/', { options: [] }).data.ftpPasvMode, true);
});

test('-rawsettings consumes the parameters that follow it', () => {
  const opts = O.Options.fromCommandLine('-rawsettings Compression=1 SendBuf=0');
  const r = S.parseUrl('sftp://h/', { options: opts });
  assert.strictEqual(r.data.compression, true);
  assert.strictEqual(r.data.sendBuf, 0);
});

test('-passwordsfromfiles is reported, and the read itself is the callers', () => {
  const r = S.parseUrl('sftp://u:pw-file@h/', { options: ['-passwordsfromfiles'] });
  assert.strictEqual(r.passwordsFromFiles, true);
  // Parse-only never consumes the file, which may be a one-shot pipe.
  const r2 = S.parseUrl('sftp://u:pw-file@h/', {
    options: ['-passwordsfromfiles'], flags: S.PUF.PARSE_ONLY,
  });
  assert.strictEqual(r2.passwordsFromFiles, false);

  const reads = [];
  const d = S.defaultSessionData();
  d.password = 'pwfile';
  d.tunnelPassword = 'tfile';
  S.readPasswordsFromFiles(d, (name) => { reads.push(name); return `line-of-${name}`; });
  assert.strictEqual(d.password, 'line-of-pwfile');
  assert.strictEqual(d.tunnelPassword, 'line-of-tfile');
  assert.deepStrictEqual(reads, ['pwfile', 'tfile']);
});

test('a non-numeric -timeout is rejected rather than silently becoming NaN', () => {
  assert.throws(() => S.parseUrl('sftp://h/', { options: ['-timeout=soon'] }),
    /is not a valid number/);
});

/* ================================================================== */
/* generateOpenCommandArgs                                             */
/* ================================================================== */

test('the open command puts what the URL cannot say into switches', () => {
  const d = S.defaultSessionData();
  d.hostName = 'example.com'; d.userName = 'martin'; d.password = 'pw';
  d.publicKeyFile = 'C:\\keys\\id.ppk';
  d.timeout = 60;
  d.compression = true;
  const args = S.generateOpenCommandArgs(d);
  assert.ok(args.startsWith('sftp://martin:pw@example.com/'), args);
  assert.ok(args.includes(' -privatekey="C:\\keys\\id.ppk"'), args);
  assert.ok(args.includes(' -timeout=60'), args);
  assert.ok(args.includes(' -rawsettings Compression=1'), args);
});

test('SFTP-only survives the open command as a raw setting, since no scheme says it', () => {
  const d = S.defaultSessionData();
  d.hostName = 'h'; d.protocol = 'sftpOnly';
  assert.ok(S.generateOpenCommandArgs(d).includes('FSProtocol=2'));
});

/* ================================================================== */
/* password masking                                                    */
/* ================================================================== */

test('maskPasswords replaces every secret and leaves the empty ones empty', () => {
  const d = S.defaultSessionData();
  d.password = 'a'; d.proxyPassword = 'b'; d.tunnelPassphrase = 'c'; d.encryptKey = 'd';
  S.maskPasswords(d);
  assert.strictEqual(d.password, '***');
  assert.strictEqual(d.proxyPassword, '***');
  assert.strictEqual(d.tunnelPassphrase, '***');
  assert.strictEqual(d.encryptKey, '***');
  assert.strictEqual(d.newPassword, '');
  assert.strictEqual(d.passphrase, '');
});

test('the has-password predicates match what maskPasswords and clear touch', () => {
  const d = S.defaultSessionData();
  assert.strictEqual(S.hasAnyPassword(d), false);
  d.proxyPassword = 'x';
  assert.strictEqual(S.hasAnySessionPassword(d), false, 'a proxy password is not a session one');
  assert.strictEqual(S.hasAnyPassword(d), true);
  d.password = 'y';
  assert.strictEqual(S.hasAnySessionPassword(d), true);
  S.clearSessionPasswords(d);
  assert.strictEqual(S.hasAnySessionPassword(d), false);
  assert.strictEqual(d.proxyPassword, 'x', 'clearing session passwords keeps the proxy one');
});

test('a sensitive switch is recognised so it never reaches a log', () => {
  assert.strictEqual(S.isSensitiveOption('password', 'x'), true);
  assert.strictEqual(S.isSensitiveOption('PASSPHRASE', 'x'), true);
  assert.strictEqual(S.isSensitiveOption('newpassword', 'x'), true);
  assert.strictEqual(S.isSensitiveOption('username', 'x'), false);
  // A private key given as a path is not itself a secret; key material is.
  assert.strictEqual(S.isSensitiveOption('privatekey', 'C:\\keys\\id.ppk'), false);
  assert.strictEqual(S.isSensitiveOption('privatekey', '-----BEGIN OPENSSH PRIVATE KEY-----\nx'), true);
});

test('a secret inside a -rawsettings parameter is masked by key name', () => {
  assert.deepStrictEqual(S.maskPasswordInOptionParameter('rawsettings', 'TunnelPasswordPlain=abc'),
    { masked: true, param: 'TunnelPasswordPlain=***' });
  assert.deepStrictEqual(S.maskPasswordInOptionParameter('rawsettings', 'Timeout=5'),
    { masked: false, param: 'Timeout=5' });
  assert.deepStrictEqual(S.maskPasswordInOptionParameter('other', 'EncryptKey=abc'),
    { masked: false, param: 'EncryptKey=abc' });
  assert.strictEqual(S.isOptionWithParameters('rawsettings'), true);
  assert.strictEqual(S.isOptionWithParameters('password'), false);
});

test('an INI written from a session with secrets keeps them out of the encrypted names', () => {
  const d = S.defaultSessionData();
  d.password = 'p'; d.tunnelPassword = 't'; d.encryptKey = 'e'; d.proxyPassword = 'x';
  const v = S.saveSession(d);
  assert.strictEqual(v.PasswordPlain, 'p');
  assert.strictEqual(v.TunnelPasswordPlain, 't');
  assert.strictEqual(v.EncryptKeyPlain, 'e');
  assert.strictEqual(v.ProxyPassword, 'x');
  for (const k of ['Password', 'TunnelPassword', 'EncryptKey', 'ProxyPasswordEnc']) {
    assert.ok(!(k in v), `${k} must not be written alongside its plain form`);
  }
});

/* ================================================================== */
/* INI import / export                                                 */
/* ================================================================== */

test('sites round trip through a WinSCP INI file, folders and all', () => {
  const a = S.defaultSessionData('work/prod');
  a.hostName = 'prod.example.com'; a.userName = 'deploy'; a.portNumber = 2200;
  a.protocol = 'ftp'; a.ftps = 'explicitTls'; a.compression = true;
  const b = S.defaultSessionData('héllo');
  b.hostName = '2001:db8::1'; b.note = 'a note with = and spaces';

  const ini = S.exportSessionsToIni([a, b]);
  assert.ok(ini.includes('[Sessions\\work/prod]'));
  const { sessions } = S.importSessionsFromIni(ini);
  assert.deepStrictEqual(sessions.map((s) => s.name), ['work/prod', 'héllo']);
  assert.strictEqual(sessions[0].portNumber, 2200);
  assert.strictEqual(sessions[0].ftps, 'explicitTls');
  assert.strictEqual(sessions[0].compression, true);
  assert.strictEqual(sessions[1].hostName, '2001:db8::1');
  assert.strictEqual(sessions[1].note, 'a note with = and spaces');
});

test('INI export refuses duplicate session names instead of dropping one', () => {
  const first = S.defaultSessionData('Prod');
  first.hostName = 'first.example.com';
  const second = S.defaultSessionData('prod');
  second.hostName = 'second.example.com';

  assert.throws(() => S.exportSessionsToIni([first, second]), /duplicate session name/i);
});

test('INI session sections and duplicate detection are case-insensitive', () => {
  const imported = S.importSessionsFromIni('[sessions\\Prod]\r\nHostName=prod.example.com\r\n');
  assert.equal(imported.sessions.length, 1);
  assert.equal(imported.sessions[0].name, 'Prod');

  assert.throws(() => S.importSessionsFromIni(
    '[Sessions\\Prod]\r\nHostName=one.example.com\r\n' +
    '[Sessions\\prod]\r\nHostName=two.example.com\r\n'),
  /duplicate session name/i);
});

test('a site is stored against the factory defaults, not the stored defaults', () => {
  // This is the pairing that keeps a file readable back: TStoredSessionList
  // saves every site against the factory defaults and loads it the same way,
  // so a site that happens to match the stored "Default Settings" still has to
  // carry its own value.
  const defaults = S.defaultSessionData('Default Settings');
  defaults.timeout = 90;
  defaults.userName = 'shared';
  const site = S.defaultSessionData('site');
  site.hostName = 'h';
  site.timeout = 90;
  const ini = S.exportSessionsToIni([site], { defaultSettings: defaults });
  assert.ok(ini.includes('[Sessions\\Default%20Settings]'));
  const imported = S.importSessionsFromIni(ini);
  assert.strictEqual(imported.defaultSettings.timeout, 90);
  assert.strictEqual(imported.defaultSettings.userName, 'shared');
  assert.strictEqual(imported.sessions[0].timeout, 90);
  assert.strictEqual(imported.sessions[0].userName, '', 'a site does not inherit on load');
  assert.strictEqual(imported.sessions[0].hostName, 'h');
  // The import dialog's behaviour, where the stored defaults do apply first.
  const withDefaults = S.importSessionsFromIni(ini, { useDefaults: true });
  assert.strictEqual(withDefaults.sessions[0].userName, 'shared');
});

test('parseIniFile keeps a value containing an equals sign intact', () => {
  const ini = S.parseIniFile('[A]\r\nKey=a=b\r\n; comment\r\n\r\n[B]\r\nX=1\r\n');
  assert.strictEqual(ini.A.Key, 'a=b');
  assert.strictEqual(ini.B.X, '1');
});

/* ================================================================== */
/* PuTTY import                                                        */
/* ================================================================== */

test('a PuTTY session imports without munging and keeps our TcpNoDelay default', () => {
  const d = S.importPuttySession({
    HostName: 'example.com', PortNumber: '2222', UserName: 'martin',
    Compression: '1', TcpNoDelay: '1', Protocol: 'ssh',
    PingIntervalSecs: '30', PingInterval: '0',
  }, 'my putty session');
  assert.strictEqual(d.hostName, 'example.com');
  assert.strictEqual(d.portNumber, 2222);
  assert.strictEqual(d.compression, true);
  // psftp/pscp ignore PuTTY's TcpNoDelay, so importing must not adopt it.
  assert.strictEqual(d.tcpNoDelay, false);
  assert.strictEqual(d.pingInterval, 30);
  assert.strictEqual(d.name, 'my putty session');
});

test('PuTTYs SSH-to-another-host proxy becomes our tunnel', () => {
  const d = S.importPuttySession({
    HostName: 'target', ProxyMethod: '6', ProxyHost: 'jump.example.com',
    ProxyPort: '2222', ProxyUsername: 'jumpuser',
  });
  assert.strictEqual(d.tunnel, true);
  assert.strictEqual(d.tunnelHostName, 'jump.example.com');
  assert.strictEqual(d.tunnelPortNumber, 2222);
  assert.strictEqual(d.tunnelUserName, 'jumpuser');
  // And the proxy settings themselves go back to their defaults.
  assert.strictEqual(d.proxyMethod, 'none');
  assert.strictEqual(d.proxyHost, 'proxy');
});

test('a PuTTY .reg export is read into sessions', () => {
  const reg = [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\my%20server]',
    '"HostName"="example.com"',
    '"PortNumber"=dword:000008ae',
    '"Compression"=dword:00000001',
    '"UserName"="mar\\\\tin"',
    '',
    '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\SshHostKeys]',
    '"rsa2@22:example.com"="0x23,0xabc"',
  ].join('\r\n');
  const sessions = S.importSessionsFromPuttyReg(reg);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].name, 'my server');
  assert.strictEqual(sessions[0].hostName, 'example.com');
  assert.strictEqual(sessions[0].portNumber, 0x8ae);
  assert.strictEqual(sessions[0].compression, true);
  assert.strictEqual(sessions[0].userName, 'mar\\tin');
});

/* ================================================================== */
/* OpenSSH config import                                               */
/* ================================================================== */

test('an OpenSSH directive may be separated by space, equals, or both', () => {
  assert.deepStrictEqual(S.parseOpensshDirective('Port 2222'), { directive: 'Port', value: '2222' });
  assert.deepStrictEqual(S.parseOpensshDirective('Port=2222'), { directive: 'Port', value: '2222' });
  assert.deepStrictEqual(S.parseOpensshDirective('  Port = 2222 '), { directive: 'Port', value: '2222' });
  assert.deepStrictEqual(S.parseOpensshDirective('"Odd Name" value'),
    { directive: 'Odd Name', value: 'value' });
  assert.strictEqual(S.parseOpensshDirective('# comment'), null);
  assert.strictEqual(S.parseOpensshDirective(''), null);
  assert.strictEqual(S.parseOpensshDirective('Bare'), null);
});

test('CutOpensshToken honours quotes and backslash escapes', () => {
  assert.deepStrictEqual(S.cutOpensshToken('one two'), { token: 'one', rest: 'two' });
  assert.deepStrictEqual(S.cutOpensshToken('"one two" three'), { token: 'one two', rest: 'three' });
  assert.deepStrictEqual(S.cutOpensshToken('one\\ two three'), { token: 'one two', rest: 'three' });
});

test('an OpenSSH config applies the matching Host block only', () => {
  const lines = [
    'Host other',
    '  Hostname wrong.example.com',
    'Host prod prod-*',
    '  Hostname prod.example.com',
    '  Port 2222',
    '  User deploy',
    '  Compression yes',
    '  ForwardAgent yes',
    'Match user root',
    '  Hostname never.example.com',
  ];
  const d = S.defaultSessionData('prod');
  S.importFromOpenssh(d, lines);
  assert.strictEqual(d.hostName, 'prod.example.com');
  assert.strictEqual(d.portNumber, 2222);
  assert.strictEqual(d.userName, 'deploy');
  assert.strictEqual(d.compression, true);
  assert.strictEqual(d.agentFwd, true);
});

test('a negated OpenSSH host pattern skips the block even after a positive match', () => {
  const lines = ['Host * !prod', '  Hostname wrong.example.com'];
  const d = S.defaultSessionData('prod');
  S.importFromOpenssh(d, lines);
  assert.strictEqual(d.hostName, '');
});

test('an OpenSSH ProxyJump becomes the tunnel, and multiple jumps are declined', () => {
  const d = S.defaultSessionData('target');
  S.importFromOpenssh(d, ['Host target', '  Hostname t.example.com', '  ProxyJump user@jump:2222']);
  assert.strictEqual(d.tunnel, true);
  assert.strictEqual(d.tunnelHostName, 'jump');
  assert.strictEqual(d.tunnelPortNumber, 2222);
  assert.strictEqual(d.tunnelUserName, 'user');

  const d2 = S.defaultSessionData('target');
  S.importFromOpenssh(d2, ['Host target', '  ProxyJump a,b']);
  assert.strictEqual(d2.tunnel, false);
});

test('the first value of an OpenSSH directive wins, as in OpenSSH itself', () => {
  const d = S.defaultSessionData('h');
  S.importFromOpenssh(d, ['Host h', '  Port 1', '  Port 2']);
  assert.strictEqual(d.portNumber, 1);
});

/* ================================================================== */
/* tunnel                                                              */
/* ================================================================== */

test('configuring a tunnel redirects to localhost and remembers the way back', () => {
  const d = S.defaultSessionData();
  d.hostName = 'target.example.com'; d.portNumber = 2222; d.proxyMethod = 'http';
  S.configureTunnel(d, 50022);
  assert.strictEqual(d.hostName, '127.0.0.1');
  assert.strictEqual(d.portNumber, 50022);
  assert.strictEqual(d.proxyMethod, 'none', 'the proxy belongs to the tunnel, not to us');
  assert.strictEqual(d.logicalHostName, 'target.example.com');
  S.rollbackTunnel(d);
  assert.strictEqual(d.hostName, 'target.example.com');
  assert.strictEqual(d.portNumber, 2222);
  assert.strictEqual(d.proxyMethod, 'http');
  assert.strictEqual(d.logicalHostName, '');
});

test('the tunnel session inherits SSH options but not the key or the bugs', () => {
  const d = S.defaultSessionData();
  d.hostName = 'target'; d.portNumber = 2222;
  d.tunnelHostName = 'jump'; d.tunnelPortNumber = 22; d.tunnelUserName = 'ju';
  d.tunnelPublicKeyFile = 'jump.ppk';
  d.publicKeyFile = 'main.ppk';
  d.compression = true;
  d.sshBugs.rekey2 = 'on';
  const t = S.createTunnelData(d, 50022);
  assert.strictEqual(t.hostName, 'jump');
  assert.strictEqual(t.userName, 'ju');
  assert.strictEqual(t.publicKeyFile, 'jump.ppk');
  assert.strictEqual(t.compression, true);
  assert.strictEqual(t.sshBugs.rekey2, 'auto', 'bug workarounds are not inherited');
  assert.strictEqual(t.tunnelPortFwd, 'L50022\ttarget:2222');
  assert.strictEqual(t.tunnel, false);
});

test('an IPv6 target is bracketed in the tunnel port forwarding', () => {
  const d = S.defaultSessionData();
  d.hostName = '2001:db8::1'; d.portNumber = 22;
  assert.strictEqual(S.createTunnelData(d, 50022).tunnelPortFwd, 'L50022\t[2001:db8::1]:22');
});

/* ================================================================== */
/* copying and state                                                   */
/* ================================================================== */

test('copyStateData moves only the per-machine state', () => {
  const src = S.defaultSessionData('src');
  src.localDirectory = 'C:\\a'; src.remoteDirectory = '/b'; src.color = '#00FF00';
  src.hostName = 'h'; src.note = 'note';
  const dst = S.defaultSessionData('dst');
  S.copyStateData(dst, src);
  assert.strictEqual(dst.localDirectory, 'C:\\a');
  assert.strictEqual(dst.color, '#00FF00');
  assert.strictEqual(dst.hostName, '', 'the host name is not state');
  assert.strictEqual(dst.note, '', 'the note is not state either');
  S.copyNonCoreData(dst, src);
  assert.strictEqual(dst.note, 'note');
});

test('hasStateData notices a colour as much as a directory', () => {
  const d = S.defaultSessionData();
  assert.strictEqual(S.hasStateData(d), false);
  assert.strictEqual(S.hasStateData({ ...d, color: '#000001' }), true);
  assert.strictEqual(S.hasStateData({ ...d, remoteDirectory: '/x' }), true);
});

test('assign copies the data and the source marker, and is a deep copy', () => {
  const src = S.defaultSessionData('src');
  src.sshBugs.rekey2 = 'on';
  src.cipherList = ['aes'];
  src.source = S.SOURCE.STORED_MODIFIED;
  const dst = S.assignSessionData(S.defaultSessionData(), src);
  assert.strictEqual(dst.source, S.SOURCE.STORED_MODIFIED);
  dst.sshBugs.rekey2 = 'off';
  dst.cipherList.push('des');
  assert.strictEqual(src.sshBugs.rekey2, 'on');
  assert.deepStrictEqual(src.cipherList, ['aes']);
});

/* ================================================================== */
/* stored list helpers                                                 */
/* ================================================================== */

test('folders and workspaces are told apart by their first member', () => {
  const site = S.defaultSessionData('work/prod');
  const ws = S.defaultSessionData('space/0001');
  ws.isWorkspace = true;
  const sessions = [site, ws];
  assert.strictEqual(S.isFolder(sessions, 'work'), true);
  assert.strictEqual(S.isWorkspace(sessions, 'work'), false);
  assert.strictEqual(S.isWorkspace(sessions, 'space'), true);
  assert.deepStrictEqual(S.getWorkspaces(sessions), ['space']);
});

test('a workspace member links to the stored site, or copies it when there is none', () => {
  const site = S.defaultSessionData('prod');
  site.hostName = 'h';
  site.remoteDirectory = '/srv';
  const linked = S.saveWorkspaceData([site], site, 1);
  assert.strictEqual(linked.link, 'prod');
  assert.strictEqual(linked.remoteDirectory, '/srv');
  assert.strictEqual(linked.name, '0001');
  assert.strictEqual(linked.isWorkspace, true);

  const adhoc = S.defaultSessionData('gone');
  adhoc.hostName = 'other';
  const copied = S.saveWorkspaceData([site], adhoc, 2);
  assert.strictEqual(copied.link, '');
  assert.strictEqual(copied.nameOverride, 'gone');
  assert.strictEqual(copied.hostName, 'other');
});

test('a workspace link resolves case-insensitively, and a cycle resolves to nothing', () => {
  const site = S.defaultSessionData('prod');
  const link = S.defaultSessionData('0001');
  link.link = 'Prod';
  assert.strictEqual(S.resolveWorkspaceData([site, link], link), site);

  const a = S.defaultSessionData('a'); a.link = 'b';
  const b = S.defaultSessionData('B'); b.link = 'A';
  assert.strictEqual(S.resolveWorkspaceData([a, b], a), null);
});

test('stored-session helpers fail closed for malformed persisted entries', () => {
  const site = S.defaultSessionData('work/prod');
  const sessions = [null, 'broken', site];

  assert.equal(S.isInFolder(sessions, 'work'), true);
  assert.equal(S.isFolder(sessions, 'work'), true);
  assert.equal(S.findSame(sessions, site), site);
  assert.equal(S.resolveWorkspaceData(null, { link: 'work/prod' }), null);
  assert.doesNotThrow(() => S.parseUrl('work/prod', {
    storedSessions: { sessions, defaultSettings: S.defaultSessionData() },
  }));
  assert.throws(() => S.saveWorkspaceData(sessions, null, 1), /Workspace session data/);
});

/* ================================================================== */
/* miscellaneous property semantics                                    */
/* ================================================================== */

test('an empty shell or return variable means "let the shell decide"', () => {
  const d = S.defaultSessionData();
  assert.strictEqual(S.isDefaultShell(d), true);
  S.setDefaultShell(d, false);
  assert.strictEqual(d.shell, '/bin/bash');
  S.setDefaultShell(d, true);
  assert.strictEqual(d.shell, '');
  assert.strictEqual(S.detectReturnVar(d), true);
  S.setDetectReturnVar(d, false);
  assert.strictEqual(d.returnVar, '$?');
});

test('disabling every authentication but the password clears the key material too', () => {
  const d = S.defaultSessionData();
  d.publicKeyFile = 'k'; d.passphrase = 'p'; d.tlsCertificateFile = 'c';
  S.disableAuthenticationsExceptPassword(d);
  assert.strictEqual(d.authKI, false);
  assert.strictEqual(d.authGSSAPI, false);
  assert.strictEqual(d.tryAgent, false);
  assert.strictEqual(d.publicKeyFile, '');
  assert.strictEqual(d.passphrase, '');
  assert.strictEqual(d.tlsCertificateFile, '');
});

test('environment variables expand in the fields that may contain one', () => {
  const env = { HOME_HOST: 'nas.local', WINUSER: 'martin' };
  const d = S.defaultSessionData();
  d.hostName = '%HOME_HOST%'; d.userName = '%WINUSER%'; d.publicKeyFile = '%MISSING%\\k';
  S.expandSessionEnvironmentVariables(d, env);
  assert.strictEqual(d.hostName, 'nas.local');
  assert.strictEqual(d.userName, 'martin');
  assert.strictEqual(d.publicKeyFile, '%MISSING%\\k', 'an unknown variable is left alone');
});

test('canOpen accepts a host, or two local directories for the local browser', () => {
  const d = S.defaultSessionData();
  assert.strictEqual(S.canOpen(d), false);
  assert.strictEqual(S.canOpen({ ...d, hostName: 'h' }), true);
  assert.strictEqual(S.canOpen({ ...d, localDirectory: 'a', otherLocalDirectory: 'b' }), true);
  assert.strictEqual(S.canOpen({ ...d, localDirectory: 'a' }), false);
});
