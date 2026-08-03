// sitedata.test.js — the DOM-free half of the session dialogs.
//
// design/renderer/ui/dialogs/{login,sitetree,generateurl,importsessions,siteadvanced}.js
// each keep their pure logic above their widgets, and none of it touches
// `document`. That is what lets this file exercise the real modules in plain
// Node instead of a re-implementation that can quietly drift from them.
//
// Covered here: session URL generation and parsing (and the round trip between
// them), WinSCP's three site-search match modes, the protocol/port/field
// visibility rules from Login.cpp's UpdateControls, and all six import parsers.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const R = (rel) => pathToFileURL(path.join(__dirname, '..', 'design', 'renderer', rel)).href;

// The renderer is ES modules and this file is CommonJS, so the modules load
// once through a shared promise every test awaits.
const modules = (async () => ({
  login: await import(R('ui/dialogs/login.js')),
  tree: await import(R('ui/dialogs/sitetree.js')),
  url: await import(R('ui/dialogs/generateurl.js')),
  imp: await import(R('ui/dialogs/importsessions.js')),
  adv: await import(R('ui/dialogs/siteadvanced.js')),
}))();

/** A site with only the fields a test cares about, defaults underneath. */
async function siteOf(fields) {
  const { tree } = await modules;
  return { ...tree.SESSION_DEFAULTS, ...fields };
}

/* ================================================================== */
/* protocol, port and field-visibility rules                           */
/* ================================================================== */

test('defaultPortFor covers every protocol and encryption combination', async () => {
  const { tree } = await modules;
  assert.strictEqual(tree.defaultPortFor('sftp'), 22);
  assert.strictEqual(tree.defaultPortFor('scp'), 22);
  assert.strictEqual(tree.defaultPortFor('ftp', 'none'), 21);
  assert.strictEqual(tree.defaultPortFor('ftp', 'explicitTls'), 21);
  assert.strictEqual(tree.defaultPortFor('ftp', 'implicit'), 990);
  assert.strictEqual(tree.defaultPortFor('webdav', 'none'), 80);
  assert.strictEqual(tree.defaultPortFor('webdav', 'implicit'), 443);
  assert.strictEqual(tree.defaultPortFor('s3', 'none'), 80);
  assert.strictEqual(tree.defaultPortFor('s3', 'implicit'), 443);
  // An unknown protocol falls back to SFTP rather than throwing mid-render.
  assert.strictEqual(tree.defaultPortFor('nonsense'), 22);
});

test('schemeFor matches the URL scheme WinSCP writes', async () => {
  const { tree } = await modules;
  assert.strictEqual(tree.schemeFor('sftp'), 'sftp');
  assert.strictEqual(tree.schemeFor('scp'), 'scp');
  assert.strictEqual(tree.schemeFor('ftp', 'none'), 'ftp');
  assert.strictEqual(tree.schemeFor('ftp', 'implicit'), 'ftps');
  assert.strictEqual(tree.schemeFor('ftp', 'explicitTls'), 'ftpes');
  assert.strictEqual(tree.schemeFor('webdav', 'none'), 'dav');
  assert.strictEqual(tree.schemeFor('webdav', 'implicit'), 'davs');
  assert.strictEqual(tree.schemeFor('s3', 'none'), 's3plain');
  assert.strictEqual(tree.schemeFor('s3', 'implicit'), 's3');
});

test('normalizeSite migrates a port that still holds the old protocol default', async () => {
  const { tree } = await modules;
  const previous = await siteOf({ protocol: 'sftp', portNumber: 22 });
  const moved = tree.normalizeSite({ ...previous, protocol: 'ftp' }, previous);
  assert.strictEqual(moved.portNumber, 21, 'SFTP:22 -> FTP should land on 21');

  // A port the user chose is never overwritten.
  const custom = await siteOf({ protocol: 'sftp', portNumber: 2222 });
  const kept = tree.normalizeSite({ ...custom, protocol: 'ftp' }, custom);
  assert.strictEqual(kept.portNumber, 2222);

  // An encryption change moves the port with it.
  const ftp = await siteOf({ protocol: 'ftp', ftps: 'none', portNumber: 21 });
  const implicit = tree.normalizeSite({ ...ftp, ftps: 'implicit' }, ftp);
  assert.strictEqual(implicit.portNumber, 990);
});

test('normalizeSite repairs an encryption the protocol does not offer', async () => {
  const { tree } = await modules;
  const site = tree.normalizeSite(await siteOf({ protocol: 'sftp', ftps: 'implicit' }));
  assert.strictEqual(site.ftps, 'none');
  const s3 = tree.normalizeSite(await siteOf({ protocol: 's3', ftps: 'explicitTls' }));
  assert.strictEqual(s3.ftps, 'implicit', 'S3 defaults to TLS, not to plain HTTP');
});

test('isDefaultPort is what decides whether a URL carries a port', async () => {
  const { tree } = await modules;
  assert.strictEqual(tree.isDefaultPort(await siteOf({ protocol: 'sftp', portNumber: 22 })), true);
  assert.strictEqual(tree.isDefaultPort(await siteOf({ protocol: 'sftp', portNumber: 2222 })), false);
  assert.strictEqual(tree.isDefaultPort(await siteOf({ protocol: 'ftp', ftps: 'implicit', portNumber: 990 })), true);
  assert.strictEqual(tree.isDefaultPort(await siteOf({ protocol: 'ftp', ftps: 'implicit', portNumber: 21 })), false);
});

test('fieldVisibility shows the FTPS combo for FTP only', async () => {
  const { tree } = await modules;
  const ftp = tree.fieldVisibility(await siteOf({ protocol: 'ftp' }));
  assert.strictEqual(ftp.ftpsCombo, true);
  assert.strictEqual(ftp.webDavsCombo, false);
  assert.strictEqual(ftp.basicFtpPanel, true);
  assert.strictEqual(ftp.basicSshPanel, false);
  assert.strictEqual(ftp.anonymousCheck, true);

  const sftp = tree.fieldVisibility(await siteOf({ protocol: 'sftp' }));
  assert.strictEqual(sftp.ftpsCombo, false);
  assert.strictEqual(sftp.ftpsLabel, false);
  assert.strictEqual(sftp.basicSshPanel, true);
  assert.strictEqual(sftp.anonymousCheck, false);
});

test('fieldVisibility shows the WebDAV encryption combo for WebDAV and S3', async () => {
  const { tree } = await modules;
  for (const protocol of ['webdav', 's3']) {
    const vis = tree.fieldVisibility(await siteOf({ protocol }));
    assert.strictEqual(vis.webDavsCombo, true, protocol);
    assert.strictEqual(vis.webDavsLabel, true, protocol);
    assert.strictEqual(vis.ftpsCombo, false, protocol);
  }
  assert.strictEqual(tree.fieldVisibility(await siteOf({ protocol: 's3' })).basicS3Panel, true);
  assert.strictEqual(tree.fieldVisibility(await siteOf({ protocol: 'webdav' })).basicS3Panel, false);
});

test('fieldVisibility renames the S3 credential labels', async () => {
  const { tree } = await modules;
  const s3 = tree.fieldVisibility(await siteOf({ protocol: 's3' }));
  assert.strictEqual(s3.userNameLabel, 'Access key ID');
  assert.strictEqual(s3.passwordLabel, 'Secret access key');
  const sftp = tree.fieldVisibility(await siteOf({ protocol: 'sftp' }));
  assert.strictEqual(sftp.userNameLabel, null);
});

test('fieldVisibility disables the credentials when there is nothing to type', async () => {
  const { tree } = await modules;
  const bypass = tree.fieldVisibility(await siteOf({ protocol: 'sftp', sshNoUserAuth: true }));
  assert.strictEqual(bypass.userNameEnabled, false);
  assert.strictEqual(bypass.passwordEnabled, false);

  const env = tree.fieldVisibility(await siteOf({ protocol: 's3', s3CredentialsEnv: true }));
  assert.strictEqual(env.userNameEnabled, false);
  assert.strictEqual(env.s3ProfileEnabled, true);

  // sshNoUserAuth on a non-SSH protocol must not disable anything.
  const ftp = tree.fieldVisibility(await siteOf({ protocol: 'ftp', sshNoUserAuth: true }));
  assert.strictEqual(ftp.userNameEnabled, true);
});

test('a read-only view swaps the combos for their text views', async () => {
  const { tree } = await modules;
  const vis = tree.fieldVisibility(await siteOf({ protocol: 'ftp' }), { editable: false });
  assert.strictEqual(vis.transferProtocolCombo, false);
  assert.strictEqual(vis.transferProtocolView, true);
  assert.strictEqual(vis.ftpsCombo, false, 'the combo is hidden but its label is not');
  assert.strictEqual(vis.ftpsLabel, true);
  assert.strictEqual(vis.encryptionView, true);
  assert.strictEqual(vis.hostNameReadOnly, true);
  assert.strictEqual(vis.editable, false);
  assert.strictEqual(vis.basicFtpPanel, true, 'the protocol panel remains visible while its controls are disabled');
});

test('saved login forms stay read-only until the reachable Edit action', async () => {
  const { login } = await modules;
  const saved = login.sessionFieldVisibility(await siteOf({ protocol: 'ftp' }), {
    sourceId: 'site-1', editing: false,
  });
  assert.strictEqual(saved.editable, false);
  assert.strictEqual(saved.transferProtocolView, true);
  assert.strictEqual(saved.encryptionView, true);
  assert.strictEqual(login.sessionFormEditable({ sourceId: 'site-1', editing: true }), true);
  assert.strictEqual(login.sessionFormEditable({ sourceId: null, editing: false }), true);
});

test('isAnonymous recognises WinSCP’s anonymous FTP pair, case-insensitively', async () => {
  const { tree } = await modules;
  assert.strictEqual(tree.isAnonymous({ userName: 'anonymous', password: 'anonymous@example.com' }), true);
  assert.strictEqual(tree.isAnonymous({ userName: 'Anonymous', password: 'ANONYMOUS@example.com' }), true);
  assert.strictEqual(tree.isAnonymous({ userName: 'anonymous', password: 'hunter2' }), false);
  assert.strictEqual(tree.isAnonymous({}), false);
});

/* ================================================================== */
/* session URL generation                                              */
/* ================================================================== */

test('buildSessionUrl omits the port when it is the protocol default', async () => {
  const { url } = await modules;
  const site = await siteOf({ protocol: 'sftp', hostName: 'example.com', portNumber: 22, userName: 'bob' });
  assert.strictEqual(url.buildSessionUrl(site), 'sftp://bob@example.com/');
  assert.strictEqual(url.buildSessionUrl({ ...site, portNumber: 2222 }), 'sftp://bob@example.com:2222/');
});

test('buildSessionUrl leaves the user name out when the flag is off', async () => {
  const { url } = await modules;
  const site = await siteOf({ protocol: 'ftp', hostName: 'files.example.org', portNumber: 21, userName: 'bob' });
  assert.strictEqual(url.buildSessionUrl(site, { userName: false }), 'ftp://files.example.org/');
});

test('buildSessionUrl includes a password only when explicitly asked', async () => {
  const { url } = await modules;
  const site = await siteOf({ protocol: 'sftp', hostName: 'h', userName: 'u', password: 'p@ss:word' });
  assert.strictEqual(url.buildSessionUrl(site), 'sftp://u@h/');
  assert.strictEqual(url.buildSessionUrl(site, { password: true }), 'sftp://u:p%40ss%3Aword@h/');
  assert.strictEqual(url.urlIncludesSecret(site, { password: true }), true);
  assert.strictEqual(url.urlIncludesSecret(site, {}), false);
});

test('buildSessionUrl never treats the stored-secret sentinel as a password', async () => {
  const { url, tree } = await modules;
  const site = await siteOf({ protocol: 'sftp', hostName: 'h', userName: 'u', password: tree.SECRET_SENTINEL });
  assert.strictEqual(url.buildSessionUrl(site, { password: true }), 'sftp://u@h/');
  assert.strictEqual(url.urlIncludesSecret(site, { password: true }), false);
});

test('buildSessionUrl brackets an IPv6 literal', async () => {
  const { url } = await modules;
  const site = await siteOf({ protocol: 'sftp', hostName: '2001:db8::1', portNumber: 2222, userName: 'u' });
  assert.strictEqual(url.buildSessionUrl(site), 'sftp://u@[2001:db8::1]:2222/');
});

test('buildSessionUrl percent-encodes an IPv6 zone identifier', async () => {
  const { url } = await modules;
  const site = await siteOf({ protocol: 'sftp', hostName: 'fe80::1%12', userName: 'u' });
  const generated = url.buildSessionUrl(site);
  assert.strictEqual(generated, 'sftp://u@[fe80::1%2512]/');
  assert.strictEqual(url.parseSessionUrl(generated).hostName, 'fe80::1%12');
});

test('buildSessionUrl writes the winscp- prefix, fingerprint, path and save extension', async () => {
  const { url } = await modules;
  const site = await siteOf({
    protocol: 'sftp', hostName: 'h', userName: 'u', hostKey: 'ssh-ed25519 255 aa:bb',
    remoteDirectory: '/srv/www',
  });
  const built = url.buildSessionUrl(site, {
    winscpSpecific: true, hostKey: true, remoteDirectory: true, saveExtension: true,
  });
  assert.strictEqual(built, 'winscp-sftp://u;fingerprint=ssh-ed25519%20255%20aa%3Abb@h/srv/www;save');
});

test('buildSessionUrl emits only the raw settings that differ from the defaults', async () => {
  const { url } = await modules;
  const plain = await siteOf({ protocol: 'sftp', hostName: 'h', userName: 'u' });
  assert.strictEqual(url.buildSessionUrl(plain, { rawSettings: true }), 'sftp://u@h/');

  const tuned = await siteOf({ protocol: 'sftp', hostName: 'h', userName: 'u', compression: true, timeout: 45 });
  const built = url.buildSessionUrl(tuned, { rawSettings: true });
  assert.ok(built.includes('x-compression=1'), built);
  assert.ok(built.includes('x-timeout=45'), built);
});

test('buildSessionUrl uses the encryption-specific scheme', async () => {
  const { url } = await modules;
  const base = { hostName: 'h', userName: 'u' };
  assert.strictEqual(url.buildSessionUrl(await siteOf({ ...base, protocol: 'ftp', ftps: 'implicit', portNumber: 990 })), 'ftps://u@h/');
  assert.strictEqual(url.buildSessionUrl(await siteOf({ ...base, protocol: 'ftp', ftps: 'explicitTls', portNumber: 21 })), 'ftpes://u@h/');
  assert.strictEqual(url.buildSessionUrl(await siteOf({ ...base, protocol: 'webdav', ftps: 'implicit', portNumber: 443 })), 'davs://u@h/');
  assert.strictEqual(url.buildSessionUrl(await siteOf({ ...base, protocol: 's3', ftps: 'none', portNumber: 80 })), 's3plain://u@h/');
});

/* ================================================================== */
/* session URL parsing                                                 */
/* ================================================================== */

test('parseSessionUrl reads every scheme back to its protocol and encryption', async () => {
  const { url } = await modules;
  const cases = [
    ['sftp://h/', 'sftp', 'none', 22],
    ['ssh://h/', 'sftp', 'none', 22],
    ['scp://h/', 'scp', 'none', 22],
    ['ftp://h/', 'ftp', 'none', 21],
    ['ftps://h/', 'ftp', 'implicit', 990],
    ['ftpes://h/', 'ftp', 'explicitTls', 21],
    ['dav://h/', 'webdav', 'none', 80],
    ['davs://h/', 'webdav', 'implicit', 443],
    ['s3://h/', 's3', 'implicit', 443],
    ['s3plain://h/', 's3', 'none', 80],
    ['http://h/', 'webdav', 'none', 80],
    ['https://h/', 'webdav', 'implicit', 443],
  ];
  for (const [input, protocol, ftps, port] of cases) {
    const got = url.parseSessionUrl(input);
    assert.strictEqual(got.ok, true, input);
    assert.strictEqual(got.protocol, protocol, input);
    assert.strictEqual(got.ftps, ftps, input);
    assert.strictEqual(got.portNumber, port, input);
  }
});

test('parseSessionUrl promotes a known S3 endpoint out of WebDAV', async () => {
  const { url } = await modules;
  const s3 = url.parseSessionUrl('https://s3.eu-west-1.amazonaws.com/');
  assert.strictEqual(s3.protocol, 's3');
  assert.strictEqual(s3.ftps, 'implicit');

  const dav = url.parseSessionUrl('https://dav.example.com/');
  assert.strictEqual(dav.protocol, 'webdav');

  // Only a genuine suffix match, never a host that merely contains the string.
  const impostor = url.parseSessionUrl('https://amazonaws.com.evil.example/');
  assert.strictEqual(impostor.protocol, 'webdav');
});

test('parseSessionUrl splits credentials on the LAST @', async () => {
  const { url } = await modules;
  const got = url.parseSessionUrl('sftp://user:p%40ss@host.example/');
  assert.strictEqual(got.userName, 'user');
  assert.strictEqual(got.password, 'p@ss');
  assert.strictEqual(got.hasPassword, true);
  assert.strictEqual(got.hostName, 'host.example');
});

test('parseSessionUrl reads the fingerprint and x- parameters', async () => {
  const { url } = await modules;
  const got = url.parseSessionUrl('sftp://u;fingerprint=ssh-rsa%202048%20aa;x-compression=1;x-timeout=45@h/');
  assert.strictEqual(got.userName, 'u');
  assert.strictEqual(got.hostKey, 'ssh-rsa 2048 aa');
  assert.deepStrictEqual(got.rawSettings, { compression: '1', timeout: '45' });
});

test('parseSessionUrl reads a bracketed IPv6 host with and without a port', async () => {
  const { url } = await modules;
  const withPort = url.parseSessionUrl('sftp://[2001:db8::1]:2222/');
  assert.strictEqual(withPort.hostName, '2001:db8::1');
  assert.strictEqual(withPort.portNumber, 2222);

  const noPort = url.parseSessionUrl('sftp://[fe80::1]/');
  assert.strictEqual(noPort.hostName, 'fe80::1');
  assert.strictEqual(noPort.portNumber, 22);
});

test('parseSessionUrl reads the path and the save extension', async () => {
  const { url } = await modules;
  const got = url.parseSessionUrl('sftp://u@h/var/www%20root/;save');
  assert.strictEqual(got.remoteDirectory, '/var/www root/');
  assert.strictEqual(got.saveOnly, true);

  const noSave = url.parseSessionUrl('sftp://u@h/var/www');
  assert.strictEqual(noSave.saveOnly, false);
  assert.strictEqual(noSave.remoteDirectory, '/var/www');
});

test('parseSessionUrl accepts the winscp- prefix and reports it', async () => {
  const { url } = await modules;
  const got = url.parseSessionUrl('winscp-sftp://u@h/');
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.winscpSpecific, true);
  assert.strictEqual(got.protocol, 'sftp');
});

test('parseSessionUrl treats a bare host as a host, not an error', async () => {
  const { url } = await modules;
  const got = url.parseSessionUrl('files.example.org');
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.protocolDefined, false);
  assert.strictEqual(got.hostName, 'files.example.org');
  assert.strictEqual(got.protocol, 'sftp');
});

test('parseSessionUrl refuses what it cannot honour, with a reason', async () => {
  const { url } = await modules;
  assert.strictEqual(url.parseSessionUrl('').ok, false);
  assert.strictEqual(url.parseSessionUrl('   ').ok, false);

  const badScheme = url.parseSessionUrl('mailto://someone@example.com/');
  assert.strictEqual(badScheme.ok, false);
  assert.match(badScheme.error, /mailto/);

  const badPort = url.parseSessionUrl('sftp://h:99999/');
  assert.strictEqual(badPort.ok, false);
  assert.match(badPort.error, /port/i);

  const noHost = url.parseSessionUrl('sftp:///path');
  assert.strictEqual(noHost.ok, false);
  assert.match(noHost.error, /host/i);

  const unclosed = url.parseSessionUrl('sftp://[2001:db8::1/');
  assert.strictEqual(unclosed.ok, false);
  assert.match(unclosed.error, /bracket/i);
});

test('a generated URL parses back to the same session', async () => {
  const { url } = await modules;
  const cases = [
    { protocol: 'sftp', hostName: 'example.com', portNumber: 2222, userName: 'bob', ftps: 'none' },
    { protocol: 'ftp', hostName: 'files.example.org', portNumber: 990, userName: 'alice', ftps: 'implicit' },
    { protocol: 'ftp', hostName: 'files.example.org', portNumber: 21, userName: 'alice', ftps: 'explicitTls' },
    { protocol: 'webdav', hostName: 'dav.example.net', portNumber: 443, userName: 'carol', ftps: 'implicit' },
    { protocol: 's3', hostName: 's3.eu-west-1.amazonaws.com', portNumber: 443, userName: 'AKIA', ftps: 'implicit' },
    { protocol: 'scp', hostName: '2001:db8::5', portNumber: 22, userName: 'dan', ftps: 'none' },
  ];
  for (const fields of cases) {
    const site = await siteOf({ ...fields, remoteDirectory: '/data/logs' });
    const generated = url.buildSessionUrl(site, { userName: true, remoteDirectory: true });
    const parsed = url.parseSessionUrl(generated);
    assert.strictEqual(parsed.ok, true, generated);
    assert.strictEqual(parsed.protocol, site.protocol, generated);
    assert.strictEqual(parsed.ftps, site.ftps, generated);
    assert.strictEqual(parsed.hostName, site.hostName, generated);
    assert.strictEqual(parsed.portNumber, site.portNumber, generated);
    assert.strictEqual(parsed.userName, site.userName, generated);
    assert.strictEqual(parsed.remoteDirectory, '/data/logs', generated);
  }
});

test('siteFromParsedUrl turns a parse into a site patch', async () => {
  const { url } = await modules;
  const patch = url.siteFromParsedUrl(url.parseSessionUrl('ftps://u:pw@h:990/pub;save'));
  assert.strictEqual(patch.protocol, 'ftp');
  assert.strictEqual(patch.ftps, 'implicit');
  assert.strictEqual(patch.password, 'pw');
  assert.strictEqual(patch.savePassword, true);
  assert.strictEqual(patch.remoteDirectory, '/pub');

  const raw = url.siteFromParsedUrl(url.parseSessionUrl('sftp://u;x-compression=1;x-timeout=45;x-tunnel=1@h/'));
  assert.strictEqual(raw.compression, true);
  assert.strictEqual(raw.timeout, 45);
  assert.strictEqual(raw.tunnel, true);

  assert.strictEqual(url.siteFromParsedUrl({ ok: false }), null);
});

/* ================================================================== */
/* generated script and .NET code                                      */
/* ================================================================== */

test('the script snippet puts the host key on -hostkey, not in the URL', async () => {
  const { url } = await modules;
  const site = await siteOf({ protocol: 'sftp', hostName: 'h', userName: 'u', hostKey: 'ssh-ed25519 255 aa' });
  const script = url.buildScript(site, 'script', { userName: true, hostKey: true });
  assert.ok(script.text.includes('-hostkey="ssh-ed25519 255 aa"'), script.text);
  assert.ok(!script.text.includes('fingerprint='), script.text);
});

test('every script format keeps its line continuations well-formed', async () => {
  const { url } = await modules;
  const site = await siteOf({ protocol: 'sftp', hostName: 'h', userName: 'u', remoteDirectory: '/srv' });
  const batch = url.buildScript(site, 'batch', {}).text.split('\n');
  const lastCommand = batch.findIndex((l) => l.trim() === '');
  // Every continued line ends with ^ and the last command line does not.
  assert.ok(batch.slice(2, lastCommand - 1).every((l) => l.endsWith('^')), batch.join('\n'));
  assert.ok(!batch[lastCommand - 1].endsWith('^'), batch.join('\n'));

  const ps = url.buildScript(site, 'powershell', {}).text;
  assert.ok(ps.includes('$PSNativeCommandArgumentPassing = "Legacy"'), ps);
  assert.ok(!/`\n\n/.test(ps), 'a dangling backtick would swallow the blank line');

  const cli = url.buildScript(site, 'commandline', {}).text;
  assert.ok(cli.startsWith('/log='), cli);
  assert.ok(cli.includes('/command'), cli);
});

test('the .NET snippet never embeds a password, in any language', async () => {
  const { url } = await modules;
  const site = await siteOf({
    protocol: 'sftp', hostName: 'h', userName: 'u', password: 'hunter2',
    hostKey: 'ssh-ed25519 255 aa',
  });
  for (const language of ['csharp', 'vbnet', 'powershell']) {
    const code = url.buildAssemblyCode(site, language, { password: true, hostKey: true });
    assert.strictEqual(code.includesSecret, false, language);
    assert.ok(!code.text.includes('hunter2'), `${language} leaked the password:\n${code.text}`);
    assert.match(code.text, /Password\s*=\s*(null|Nothing|\$null)/, language);
    assert.ok(code.text.includes('ssh-ed25519 255 aa'), language);
  }
});

test('the .NET snippet reflects the protocol, port and TLS mode', async () => {
  const { url } = await modules;
  const ftps = await siteOf({ protocol: 'ftp', ftps: 'implicit', hostName: 'h', portNumber: 990, userName: 'u' });
  const cs = url.buildAssemblyCode(ftps, 'csharp').text;
  assert.ok(cs.includes('Protocol = Protocol.Ftp,'), cs);
  assert.ok(cs.includes('FtpSecure = FtpSecure.Implicit,'), cs);
  assert.ok(!cs.includes('PortNumber'), 'the default port should not be written');

  const odd = await siteOf({ protocol: 'sftp', hostName: 'h', portNumber: 2222, userName: 'u' });
  assert.ok(url.buildAssemblyCode(odd, 'csharp').text.includes('PortNumber = 2222,'));
});

/* ================================================================== */
/* the three site-search match modes                                   */
/* ================================================================== */

test('containsTextSemiCaseSensitive is case-insensitive only for a lowercase needle', async () => {
  const { tree } = await modules;
  assert.strictEqual(tree.containsTextSemiCaseSensitive('Production', 'prod'), true);
  assert.strictEqual(tree.containsTextSemiCaseSensitive('Production', 'PROD'), false);
  assert.strictEqual(tree.containsTextSemiCaseSensitive('PRODUCTION', 'PROD'), true);
  assert.strictEqual(tree.containsTextSemiCaseSensitive('db-01', 'DB'), false);
  assert.strictEqual(tree.containsTextSemiCaseSensitive('DB-01', 'DB'), true);
  // An empty needle matches everything, which is what "no filter" means.
  assert.strictEqual(tree.containsTextSemiCaseSensitive('anything', ''), true);
});

/** A small tree: two folders, four sites, one workspace. */
async function fixtureTree(expanded) {
  const { tree } = await modules;
  const sites = [
    { id: 's1', name: 'Production web', folder: 'Work', hostName: 'web.example.com', userName: 'deploy', note: 'main site' },
    { id: 's2', name: 'Staging web', folder: 'Work', hostName: 'staging.example.com', userName: 'deploy', note: '' },
    { id: 's3', name: 'Backups', folder: 'Personal', hostName: 'nas.local', userName: 'me', note: 'photos and prod dumps' },
    { id: 's4', name: 'Router', folder: '', hostName: '192.168.1.1', userName: 'admin', note: '' },
  ];
  return tree.buildSiteTree({
    sites,
    folders: ['Work', 'Personal'],
    workspaces: [{ name: 'Morning', sessions: [] }],
    expanded: expanded === undefined ? undefined : new Set(expanded),
  });
}

test('mode "nameStartOnly" matches a prefix of the label only', async () => {
  const { tree } = await modules;
  const nodes = await fixtureTree();
  const hits = tree.filterSiteNodes(nodes, 'prod', 'nameStartOnly').map((n) => n.label);
  assert.deepStrictEqual(hits, ['Production web']);
  assert.deepStrictEqual(tree.filterSiteNodes(nodes, 'web', 'nameStartOnly').map((n) => n.label), []);
});

test('mode "name" matches any part of the label', async () => {
  const { tree } = await modules;
  const nodes = await fixtureTree();
  const hits = tree.filterSiteNodes(nodes, 'web', 'name').map((n) => n.label).sort();
  assert.deepStrictEqual(hits, ['Production web', 'Staging web']);
  // Folders and workspaces are matched by their label too.
  assert.deepStrictEqual(tree.filterSiteNodes(nodes, 'Work', 'name').map((n) => n.label), ['Work']);
});

test('mode "all" also searches host, user and note — but only on site nodes', async () => {
  const { tree } = await modules;
  const nodes = await fixtureTree();

  assert.deepStrictEqual(
    tree.filterSiteNodes(nodes, 'nas.local', 'all').map((n) => n.label), ['Backups'],
    'host name should be searched');
  assert.deepStrictEqual(
    tree.filterSiteNodes(nodes, 'admin', 'all').map((n) => n.label), ['Router'],
    'user name should be searched');
  assert.deepStrictEqual(
    tree.filterSiteNodes(nodes, 'photos', 'all').map((n) => n.label), ['Backups'],
    'note should be searched');

  // The same needle in "name" mode finds nothing, which is the whole point of
  // having three modes.
  assert.deepStrictEqual(tree.filterSiteNodes(nodes, 'photos', 'name'), []);

  // "prod" appears in a note and in a label; "all" finds both.
  const both = tree.filterSiteNodes(nodes, 'prod', 'all').map((n) => n.label).sort();
  assert.deepStrictEqual(both, ['Backups', 'Production web']);
});

test('searchSiteNodes walks forward, wraps once, and can skip the current node', async () => {
  const { tree } = await modules;
  const nodes = await fixtureTree();
  const first = tree.searchSiteNodes(nodes, 'web', 'name');
  assert.strictEqual(first.label, 'Production web');

  const next = tree.searchSiteNodes(nodes, 'web', 'name', { fromId: first.id, skipCurrent: true });
  assert.strictEqual(next.label, 'Staging web');

  // From the last hit, skipping forward wraps back round to the first.
  const wrapped = tree.searchSiteNodes(nodes, 'web', 'name', { fromId: next.id, skipCurrent: true });
  assert.strictEqual(wrapped.label, 'Production web');

  const backwards = tree.searchSiteNodes(nodes, 'web', 'name', { fromId: next.id, skipCurrent: true, reverse: true });
  assert.strictEqual(backwards.label, 'Production web');

  assert.strictEqual(tree.searchSiteNodes(nodes, 'nothing-matches-this', 'name'), null);
  assert.strictEqual(tree.searchSiteNodes(nodes, '', 'name'), null);
});

test('searchSiteNodes can refuse to look inside a collapsed folder', async () => {
  const { tree } = await modules;
  const collapsed = await fixtureTree([]);          // no folder expanded
  assert.strictEqual(
    tree.searchSiteNodes(collapsed, 'Production', 'name', { allowExpanding: false }), null,
    'a hidden node is not eligible');
  assert.ok(
    tree.searchSiteNodes(collapsed, 'Production', 'name', { allowExpanding: true }),
    'the incremental search may expand to reach it');

  const opened = await fixtureTree(['Work']);
  assert.ok(tree.searchSiteNodes(opened, 'Production', 'name', { allowExpanding: false }));
});

/* ================================================================== */
/* the tree builder                                                    */
/* ================================================================== */

test('buildSiteTree nests folders, orders kinds and materialises missing folders', async () => {
  const { tree } = await modules;
  const nodes = tree.buildSiteTree({
    sites: [{ id: 'a', name: 'Deep', folder: 'Work/EU/Prod', hostName: 'h' }],
    folders: [],
    workspaces: [{ name: 'W' }],
  });
  assert.deepStrictEqual(nodes.map((n) => n.kind), ['newSite', 'folder', 'workspace']);

  const work = nodes.find((n) => n.kind === 'folder');
  assert.strictEqual(work.label, 'Work');
  const eu = work.children[0];
  assert.strictEqual(eu.label, 'EU');
  assert.strictEqual(eu.level, 1);
  const prod = eu.children[0];
  assert.strictEqual(prod.label, 'Prod');
  assert.strictEqual(prod.children[0].label, 'Deep');
  assert.strictEqual(prod.children[0].parent, prod);

  const flat = tree.flattenTree(nodes).map((n) => n.label);
  assert.ok(flat.includes('Deep'));
});

test('folderPathsOf returns every path including the intermediate ones', async () => {
  const { tree } = await modules;
  const paths = tree.folderPathsOf([{ folder: 'a/b/c' }], ['x']);
  assert.deepStrictEqual(paths, ['a', 'a/b', 'a/b/c', 'x']);
});

test('stripSecrets removes the sentinel so it is never written back', async () => {
  const { tree } = await modules;
  const cleaned = tree.stripSecrets({
    hostName: 'h', password: tree.SECRET_SENTINEL, tunnelPassword: tree.SECRET_SENTINEL, encryptKey: 'real',
  }, { keep: ['encryptKey'] });
  assert.strictEqual('password' in cleaned, false);
  assert.strictEqual('tunnelPassword' in cleaned, false);
  assert.strictEqual(cleaned.encryptKey, 'real');
  assert.strictEqual(cleaned.hostName, 'h');
});

/* ================================================================== */
/* import parsers — PuTTY / KiTTY                                      */
/* ================================================================== */

const PUTTY_REG = [
  'Windows Registry Editor Version 5.00',
  '',
  String.raw`[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\My%20Server]`,
  '"HostName"="example.com"',
  '"PortNumber"=dword:00000016',
  '"UserName"="bob"',
  '"Protocol"="ssh"',
  '"Compression"=dword:00000001',
  String.raw`"PublicKeyFile"="C:\\keys\\id.ppk"`,
  '"Cipher"="aes,chacha20,3des"',
  '',
  String.raw`[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Behind%20jump]`,
  '"HostName"="deploy@internal.example"',
  '"ProxyMethod"=dword:00000006',
  '"ProxyHost"="jump.example.net"',
  '"ProxyPort"=dword:00000016',
  '',
  String.raw`[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\SshHostKeys]`,
  '"rsa2@22:example.com"="0x23,0xabc"',
].join('\r\n');

test('parsePuttyRegistry reads sessions and decodes the value forms', async () => {
  const { imp } = await modules;
  const found = imp.parsePuttyRegistry(PUTTY_REG);
  assert.strictEqual(found.length, 2, 'only Sessions keys become sites');

  const server = found[0];
  assert.strictEqual(server.site.name, 'My Server', 'the %20 in the key name is decoded');
  assert.strictEqual(server.site.hostName, 'example.com');
  assert.strictEqual(server.site.portNumber, 22, 'dword:00000016 is hex for 22');
  assert.strictEqual(server.site.userName, 'bob');
  assert.strictEqual(server.site.compression, true);
  assert.strictEqual(server.site.publicKeyFile, 'C:\\keys\\id.ppk', 'the \\\\ escape is undone');
  assert.deepStrictEqual(server.site.cipherList, ['aes', 'chacha20', '3des']);
  assert.strictEqual(server.site.protocol, 'sftp');
});

test('parsePuttyRegistry splits user@host and converts an SSH proxy into a tunnel', async () => {
  const { imp } = await modules;
  const jump = imp.parsePuttyRegistry(PUTTY_REG)[1];
  assert.strictEqual(jump.site.userName, 'deploy');
  assert.strictEqual(jump.site.hostName, 'internal.example');
  assert.strictEqual(jump.site.tunnel, true);
  assert.strictEqual(jump.site.tunnelHostName, 'jump.example.net');
  assert.strictEqual(jump.site.tunnelPortNumber, 22);
  assert.strictEqual(jump.site.proxyMethod, 'none');
});

test('parsePuttyRegistry warns rather than silently importing a non-SSH session', async () => {
  const { imp } = await modules;
  const reg = [
    String.raw`[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Serial]`,
    '"HostName"="COM3"',
    '"Protocol"="serial"',
  ].join('\r\n');
  const [entry] = imp.parsePuttyRegistry(reg);
  assert.strictEqual(entry.site.protocol, 'sftp');
  assert.strictEqual(entry.site.puttyProtocol, 'serial');
  assert.ok(entry.warnings.some((w) => /serial/.test(w)), entry.warnings.join('|'));
});

test('parsePuttyRegistry also accepts KiTTY’s key path', async () => {
  const { imp } = await modules;
  const reg = [
    String.raw`[HKEY_CURRENT_USER\Software\9bis.com\KiTTY\Sessions\Kit]`,
    '"HostName"="kitty.example"',
  ].join('\r\n');
  const found = imp.parsePuttyRegistry(reg, { source: 'kitty' });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].site.hostName, 'kitty.example');
  assert.strictEqual(found[0].source, 'kitty');
});

test('site tree UI state persists only safe navigation identifiers', async () => {
  const { tree } = await modules;
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  assert.strictEqual(tree.writeSiteTreeState({ expanded: new Set(['Work', 'Work/EU']), selectedId: 'site:s1' }, storage), true);
  assert.deepStrictEqual(tree.readSiteTreeState(storage), { expanded: new Set(['Work', 'Work/EU']), selectedId: 'site:s1' });
  assert.ok(!values.get('winscp-material.renderer.site-tree').includes('password'));
});

test('decodePuttySessionName matches WinSCP UTF-8 percent decoding', async () => {
  const { imp } = await modules;
  assert.strictEqual(
    imp.decodePuttySessionName('%E9%A6%99%E6%B8%AF%20%2B%20Prod+1'),
    '香港 + Prod 1',
  );

  const reg = [
    String.raw`[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\%E9%A6%99%E6%B8%AF%20%2B%20Prod+1]`,
    '"HostName"="example.test"',
  ].join('\r\n');
  const [entry] = imp.parsePuttyRegistry(reg);
  assert.strictEqual(entry.site.name, '香港 + Prod 1');
  assert.strictEqual(imp.decodePuttySessionName('%E9%A6%99%E6%B8%AF%ZZ'), '香港%ZZ');
});

test('decodeRegValue handles strings, dwords and hex(2) expandable strings', async () => {
  const { imp } = await modules;
  assert.deepStrictEqual(imp.decodeRegValue('"plain"'), { kind: 'string', value: 'plain' });
  assert.deepStrictEqual(imp.decodeRegValue(String.raw`"a\\b"`), { kind: 'string', value: 'a\\b' });
  assert.deepStrictEqual(imp.decodeRegValue(String.raw`"say \"hi\""`), { kind: 'string', value: 'say "hi"' });
  assert.deepStrictEqual(imp.decodeRegValue('dword:0000ffff'), { kind: 'number', value: 65535 });
  // "Hi" as UTF-16LE with the trailing NUL.
  assert.deepStrictEqual(imp.decodeRegValue('hex(2):48,00,69,00,00,00'), { kind: 'string', value: 'Hi' });
});

/* ================================================================== */
/* import parsers — FileZilla                                          */
/* ================================================================== */

const FZ_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FileZilla3 version="3.66.4">
  <Servers>
    <Folder expanded="1">Work
      <Server>
        <Host>ftp.example.org</Host>
        <Port>21</Port>
        <Protocol>4</Protocol>
        <Logontype>1</Logontype>
        <User>alice</User>
        <Pass encoding="base64">c2VjcmV0</Pass>
        <RemoteDir>1 0 3 pub 4 test</RemoteDir>
        <Comments>Nightly drop &amp; archive</Comments>
        <PasvMode>MODE_ACTIVE</PasvMode>
        <Name>Prod FTP</Name>
      </Server>
    </Folder>
    <Server>
      <Host>sftp.example.net</Host>
      <Port>2222</Port>
      <Protocol>1</Protocol>
      <Logontype>0</Logontype>
      <Name>Anon SFTP</Name>
    </Server>
    <Server>
      <Host>vault.example.net</Host>
      <Protocol>0</Protocol>
      <Logontype>4</Logontype>
      <User>carol</User>
      <Name>Key vault</Name>
    </Server>
  </Servers>
</FileZilla3>`;

test('parseFileZillaXml maps protocols, folders, credentials and comments', async () => {
  const { imp } = await modules;
  const found = imp.parseFileZillaXml(FZ_XML);
  assert.strictEqual(found.length, 3);

  const prod = found[0];
  assert.strictEqual(prod.site.name, 'Prod FTP');
  assert.strictEqual(prod.site.folder, 'Work');
  assert.strictEqual(prod.site.protocol, 'ftp');
  assert.strictEqual(prod.site.ftps, 'explicitTls', 'FileZilla protocol 4 is FTPES');
  assert.strictEqual(prod.site.userName, 'alice');
  assert.strictEqual(prod.site.password, 'secret', 'the base64 password is decoded');
  assert.strictEqual(prod.hasPassword, true);
  assert.strictEqual(prod.site.remoteDirectory, '/pub/test');
  assert.strictEqual(prod.site.note, 'Nightly drop & archive', 'the XML entity is decoded');
  assert.strictEqual(prod.site.ftpPasvMode, false);
});

test('parseFileZillaXml treats logon type 0 as anonymous and 4 as an external store', async () => {
  const { imp } = await modules;
  const [, anon, vault] = imp.parseFileZillaXml(FZ_XML);
  assert.strictEqual(anon.site.protocol, 'sftp');
  assert.strictEqual(anon.site.portNumber, 2222);
  assert.strictEqual(anon.site.userName, 'anonymous');
  assert.strictEqual(anon.site.anonymous, true);

  assert.strictEqual(vault.site.password, '');
  assert.ok(vault.warnings.some((w) => /credential store/i.test(w)), vault.warnings.join('|'));
});

test('parseFileZillaXml refuses a file that is not a site manager', async () => {
  const { imp } = await modules;
  assert.throws(() => imp.parseFileZillaXml('<Nope/>'), /FileZilla3/);
});

test('decodeFileZillaRemoteDir decodes the length-prefixed segment list', async () => {
  const { imp } = await modules;
  assert.strictEqual(imp.decodeFileZillaRemoteDir('1 0 3 pub 4 test'), '/pub/test');
  assert.strictEqual(imp.decodeFileZillaRemoteDir('1 0'), '/');
  assert.strictEqual(imp.decodeFileZillaRemoteDir(''), '');
});

test('the XML reader ignores comments, CDATA and processing instructions', async () => {
  const { imp } = await modules;
  const doc = imp.parseXml('<?xml version="1.0"?><!-- hi --><a x="1"><b><![CDATA[<raw>]]></b></a>');
  const a = imp.xmlChild(doc, 'a');
  assert.strictEqual(a.attrs.x, '1');
  assert.strictEqual(imp.xmlChild(a, 'b').text, '<raw>');
});

test('the XML reader expands only the predefined and numeric entities', async () => {
  const { imp } = await modules;
  const doc = imp.parseXml('<a>&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&unknown;</a>');
  assert.strictEqual(imp.xmlChild(doc, 'a').text, '&<>"\'AB&unknown;');
});

test('decodeBase64Utf8 round-trips multi-byte text', async () => {
  const { imp } = await modules;
  assert.strictEqual(imp.decodeBase64Utf8('c2VjcmV0'), 'secret');
  assert.strictEqual(imp.decodeBase64Utf8(Buffer.from('蝦餃 · hā gáau', 'utf8').toString('base64')), '蝦餃 · hā gáau');
  assert.strictEqual(imp.decodeBase64Utf8(''), '');
});

/* ================================================================== */
/* import parsers — OpenSSH                                            */
/* ================================================================== */

const SSH_CONFIG = `# a comment
Host bastion
  HostName bastion.example.net
  User jump
  IdentityFile ~/.ssh/id_ed25519

Host prod prod-*
  HostName 10.0.0.5
  User deploy
  Port 2222
  ProxyJump bastion

Match host anything
  User should-not-be-imported

Host *
  Compression yes
  ServerAliveInterval 30
`;

test('parseOpenSshConfig makes one site per literal Host alias', async () => {
  const { imp } = await modules;
  const found = imp.parseOpenSshConfig(SSH_CONFIG);
  assert.deepStrictEqual(found.map((e) => e.site.name), ['bastion', 'prod']);
});

test('parseOpenSshConfig applies the block first and the globals after', async () => {
  const { imp } = await modules;
  const [bastion, prod] = imp.parseOpenSshConfig(SSH_CONFIG);
  assert.strictEqual(bastion.site.hostName, 'bastion.example.net');
  assert.strictEqual(bastion.site.userName, 'jump');
  assert.strictEqual(bastion.site.publicKeyFile, '%USERPROFILE%\\.ssh\\id_ed25519');
  assert.strictEqual(bastion.site.compression, true, 'Host * applies to every alias');
  assert.strictEqual(bastion.site.pingInterval, 30);

  assert.strictEqual(prod.site.hostName, '10.0.0.5');
  assert.strictEqual(prod.site.userName, 'deploy', 'the block wins over the global');
  assert.strictEqual(prod.site.portNumber, 2222);
});

test('parseOpenSshConfig resolves ProxyJump through the config’s own aliases', async () => {
  const { imp } = await modules;
  const prod = imp.parseOpenSshConfig(SSH_CONFIG)[1];
  assert.strictEqual(prod.site.tunnel, true);
  assert.strictEqual(prod.site.tunnelHostName, 'bastion.example.net');
  assert.strictEqual(prod.site.tunnelUserName, 'jump');
  assert.strictEqual(prod.site.tunnelPortNumber, 22);
});

test('parseOpenSshConfig reports a multi-hop ProxyJump instead of half-applying it', async () => {
  const { imp } = await modules;
  const [entry] = imp.parseOpenSshConfig('Host a\n  HostName h\n  ProxyJump one,two\n');
  assert.strictEqual(entry.site.tunnel, false);
  assert.ok(entry.warnings.some((w) => /more than one hop/.test(w)), entry.warnings.join('|'));
});

test('parseOpenSshConfig accepts Key=value and quoted arguments', async () => {
  const { imp } = await modules;
  const [entry] = imp.parseOpenSshConfig('Host x\n  HostName=quoted.example\n  IdentityFile "C:\\my keys\\id"\n');
  assert.strictEqual(entry.site.hostName, 'quoted.example');
  assert.strictEqual(entry.site.publicKeyFile, 'C:\\my keys\\id');
});

test('parseOpensshDirective ignores comments and blank lines', async () => {
  const { imp } = await modules;
  assert.strictEqual(imp.parseOpensshDirective('# nope'), null);
  assert.strictEqual(imp.parseOpensshDirective('   '), null);
  assert.deepStrictEqual(imp.parseOpensshDirective('  Port  2222 '), { directive: 'Port', args: '2222' });
});

/* ================================================================== */
/* import parsers — WinSCP INI and known_hosts                         */
/* ================================================================== */

const WINSCP_INI = [
  '[Configuration\\Interface]',
  'Ignored=1',
  '',
  String.raw`[Sessions\Work%2FProd]`,
  'HostName=srv.example.com',
  'UserName=root',
  'FSProtocol=5',
  'PortNumber=443',
  'PasswordPlain=hunter2',
  'Note=the money one',
  'Compression=1',
  'KEX=ecdh,dh-gex-sha1',
  '',
  String.raw`[Sessions\Legacy]`,
  'HostName=old.example.com',
  'FSProtocol=0',
  'Password=A35C1E',
].join('\r\n');

test('parseWinScpIni reads Sessions sections and nothing else', async () => {
  const { imp } = await modules;
  const found = imp.parseWinScpIni(WINSCP_INI);
  assert.strictEqual(found.length, 2);
  assert.deepStrictEqual(found.map((e) => e.site.name), ['Prod', 'Legacy']);
});

test('parseWinScpIni takes the folder from the section name', async () => {
  const { imp } = await modules;
  const [prod] = imp.parseWinScpIni(WINSCP_INI);
  assert.strictEqual(prod.site.folder, 'Work', 'the %2F in the section name is a path separator');
  assert.strictEqual(prod.site.name, 'Prod');
  assert.strictEqual(prod.site.protocol, 's3', 'FSProtocol 5 is S3');
  assert.strictEqual(prod.site.portNumber, 443);
  assert.strictEqual(prod.site.password, 'hunter2');
  assert.strictEqual(prod.site.note, 'the money one');
  assert.strictEqual(prod.site.compression, true);
  assert.deepStrictEqual(prod.site.kexList, ['ecdh', 'dh-gex-sha1']);
});

test('parseWinScpIni refuses to import a machine-bound encrypted password', async () => {
  const { imp } = await modules;
  const legacy = imp.parseWinScpIni(WINSCP_INI)[1];
  assert.strictEqual(legacy.site.protocol, 'scp', 'FSProtocol 0 is SCP');
  assert.strictEqual(legacy.hasPassword, false);
  assert.strictEqual(legacy.site.password, '');
  assert.ok(legacy.warnings.some((w) => /encrypted/i.test(w)), legacy.warnings.join('|'));
});

test('parseKnownHosts skips hashed entries and reads a bracketed port', async () => {
  const { imp } = await modules;
  const found = imp.parseKnownHosts([
    '# comment',
    '|1|aGFzaGVk|aGFzaA== ssh-rsa AAAAB3hidden',
    '[alt.example.com]:2222 ssh-ed25519 AAAAC3Nz',
    'plain.example.com,also.example.com ssh-rsa AAAAB3Nz',
    'plain.example.com ssh-ed25519 AAAAC3Dup',
  ].join('\n'));

  assert.deepStrictEqual(found.map((e) => e.site.hostName),
    ['alt.example.com', 'plain.example.com', 'also.example.com']);
  assert.strictEqual(found[0].site.portNumber, 2222);
  assert.strictEqual(found[0].site.hostKey, 'ssh-ed25519 AAAAC3Nz');
  assert.strictEqual(found[1].site.hostKey, 'ssh-rsa AAAAB3Nz', 'the first key for a host wins');
  assert.ok(found[0].warnings.some((w) => /hashed/i.test(w)), 'the skipped hashed entry is reported');
});

test('known_hosts preview exposes algorithms without exposing key material', async () => {
  const { imp } = await modules;
  const [entry] = imp.parseKnownHosts('[host.example]:2222 ssh-ed25519 AAAA-secret-key');
  assert.deepStrictEqual(imp.knownHostAlgorithms(entry), ['ssh-ed25519']);
  assert.ok(!imp.knownHostAlgorithms(entry).some((value) => /AAAA|secret|key/i.test(value)));
  assert.deepStrictEqual(imp.knownHostAlgorithms({ site: { hostKey: '' } }), []);
});

test('importSitesFrom dispatches by source id and refuses an unknown one', async () => {
  const { imp } = await modules;
  assert.strictEqual(imp.importSitesFrom('ini', WINSCP_INI).length, 2);
  assert.strictEqual(imp.importSitesFrom('putty', PUTTY_REG).length, 2);
  assert.throws(() => imp.importSitesFrom('nonsense', ''), /not an import source/);
  assert.strictEqual(imp.IMPORT_SOURCES.length, 6);
});

test('every import source produces sites with the full default set filled in', async () => {
  const { imp, tree } = await modules;
  const inputs = { putty: PUTTY_REG, kitty: PUTTY_REG, filezilla: FZ_XML, openssh: SSH_CONFIG, ini: WINSCP_INI, knownhosts: 'h.example ssh-rsa AAAA' };
  for (const source of imp.IMPORT_SOURCES) {
    const found = imp.importSitesFrom(source.id, inputs[source.id]);
    assert.ok(found.length > 0, source.id);
    for (const entry of found) {
      for (const key of Object.keys(tree.SESSION_DEFAULTS)) {
        assert.ok(key in entry.site, `${source.id}: "${key}" missing from an imported site`);
      }
      assert.ok(entry.site.hostName, `${source.id}: a site without a host name should be dropped`);
      assert.ok(entry.site.portNumber > 0, `${source.id}: no port`);
    }
  }
});

test('the parsers refuse an input larger than the guard allows', async () => {
  const { imp } = await modules;
  const huge = 'x'.repeat(8 * 1024 * 1024 + 1);
  assert.throws(() => imp.parseWinScpIni(huge), /too large/i);
  assert.throws(() => imp.parsePuttyRegistry(huge), /too large/i);
});

/* ================================================================== */
/* advanced settings table                                             */
/* ================================================================== */

test('the advanced pages cover all eighteen sheets in the original', async () => {
  const { adv } = await modules;
  const captions = adv.SITE_ADVANCED_PAGES.map((p) => p.caption);
  assert.deepStrictEqual(captions, [
    'Environment', 'Directories', 'Recycle bin', 'Encryption', 'SFTP', 'SCP/Shell',
    'FTP', 'S3', 'WebDAV', 'Connection', 'Proxy', 'Tunnel', 'TLS/SSL', 'SSH',
    'Key exchange', 'Authentication', 'Bugs', 'Note',
  ]);
});

test('every advanced control binds to a real key with a label', async () => {
  const { adv, tree } = await modules;
  const seen = new Set();
  for (const { page, control } of adv.allAdvancedControls()) {
    assert.ok(control.id, `a control on ${page.id} has no id`);
    assert.ok(!seen.has(control.id), `duplicate control id "${control.id}"`);
    seen.add(control.id);
    assert.ok(control.label, `${control.id} has no label`);
    if (control.kind === 'static' || control.kind === 'button') continue;
    assert.ok(control.key, `${control.id} has no key`);
    const root = control.key.split('.')[0];
    assert.ok(root in tree.SESSION_DEFAULTS,
      `${control.id} writes "${control.key}", which is not in SESSION_DEFAULTS`);
  }
});

test('every gap reference resolves to a real explanation', async () => {
  const { adv } = await modules;
  for (const { control, group } of adv.allAdvancedControls()) {
    if (control.gap) assert.ok(adv.PROTOCOL_GAP_NOTES[control.gap], `${control.id}: unknown gap "${control.gap}"`);
    if (group.gap) assert.ok(adv.PROTOCOL_GAP_NOTES[group.gap], `${group.id}: unknown gap "${group.gap}"`);
  }
});

test('advancedContext derives the protocol family flags', async () => {
  const { adv } = await modules;
  const sftp = adv.advancedContext(await siteOf({ protocol: 'sftp' }));
  assert.strictEqual(sftp.ssh, true);
  assert.strictEqual(sftp.sftp, true);
  assert.strictEqual(sftp.scp, false);

  const s3 = adv.advancedContext(await siteOf({ protocol: 's3', ftps: 'implicit' }));
  assert.strictEqual(s3.neon, true);
  assert.strictEqual(s3.tls, true);
  assert.strictEqual(adv.advancedContext(await siteOf({ protocol: 'ftp', ftps: 'none' })).tls, false);
});

test('advanced order-list options provide an active-descendant target', async () => {
  const { adv } = await modules;
  assert.equal(adv.orderListOptionId('KexOrderList', 0), 'KexOrderList-option-0');
  assert.match(
    await require('node:fs').promises.readFile(
      path.join(__dirname, '..', 'design', 'renderer', 'ui', 'dialogs', 'siteadvanced.js'), 'utf8'),
    /id:\s*orderListOptionId\(id, index\)/,
  );
});

test('siteAdvancedPatch preserves ordinary edits and only sends touched secrets', async () => {
  const { adv, tree } = await modules;
  const site = await siteOf({ remoteDirectory: '/incoming', password: tree.SECRET_SENTINEL });
  const patch = adv.siteAdvancedPatch({ ...site, remoteDirectory: '/outgoing' });
  assert.strictEqual(patch.remoteDirectory, '/outgoing');
  assert.strictEqual(patch.password, undefined);
  const withSecret = adv.siteAdvancedPatch(
    { ...site, password: 'new-secret' },
    ['password'],
  );
  assert.strictEqual(withSecret.password, 'new-secret');
});

test('enabling site encryption requires a key while preserving stored secrets', async () => {
  const { adv, tree } = await modules;
  assert.deepStrictEqual(adv.encryptionKeyState({ encryptFiles: false, encryptKey: '' }),
    { enabled: false, available: false, valid: true });
  assert.equal(adv.encryptionKeyState({ encryptFiles: true, encryptKey: '' }).valid, false);
  assert.equal(adv.encryptionKeyState({ encryptFiles: true, encryptKey: tree.SECRET_SENTINEL }).valid, true);
  assert.equal(adv.encryptionKeyState({ encryptFiles: true, encryptKey: 'new-key' }).valid, true);
});

test('advanced timezone normalization rejects offsets beyond the ±24:00 boundary', async () => {
  const { adv } = await modules;
  assert.deepStrictEqual(adv.normalizeAdvancedTimezone(24, 59), { hours: 24, minutes: 0, value: 24 });
  assert.deepStrictEqual(adv.normalizeAdvancedTimezone(-24, -59), { hours: -24, minutes: 0, value: -24 });
  assert.deepStrictEqual(adv.normalizeAdvancedTimezone(-1, 30), { hours: -1, minutes: -30, value: -1.5 });
});

test('WebDAV legacy authentication persists its real key and exposes the enabled warning', async () => {
  const { adv, tree } = await modules;
  const control = adv.allAdvancedControls().find(({ control: c }) => c.id === 'WebDavAuthLegacyCheck').control;
  assert.equal(control.key, 'webDavAuthLegacy');
  assert.equal(tree.SESSION_DEFAULTS.webDavAuthLegacy, false);
  assert.match(control.warning, /credentials are sent before the server proves/i);

  const site = await siteOf({ protocol: 'webdav', webDavAuthLegacy: true });
  assert.equal(adv.getSiteKey(site, control.key), true);
  assert.equal(adv.siteAdvancedPatch(site).webDavAuthLegacy, true);
  assert.equal(adv.describeValue(control, site), 'on');
});

test('SiteAdvanced does not advertise the inert SCP fallback setting', async () => {
  const { adv } = await modules;
  assert.equal(
    adv.allAdvancedControls().some(({ control }) => control.key === 'allowScpFallback'),
    false,
  );
});

test('mergeAlgorithmOrder keeps the stored order and restores what is missing', async () => {
  const { adv } = await modules;
  const merged = adv.mergeAlgorithmOrder(['aes', 'WARN', 'des'], adv.CIPHERS);
  // The stored order survives, relative to the warning line.
  assert.ok(merged.indexOf('aes') < merged.indexOf('WARN'));
  assert.ok(merged.indexOf('des') > merged.indexOf('WARN'));
  // Every catalogue entry is reachable, so a new cipher is never lost.
  for (const [id] of adv.CIPHERS) assert.ok(merged.includes(id), id);
  // A newcomer lands on the side of the line the catalogue puts it: AES-GCM is
  // modern and must not be demoted; Blowfish is deprecated and must not be
  // promoted.
  assert.ok(merged.indexOf('aesgcm') < merged.indexOf('WARN'), merged.join(','));
  assert.ok(merged.indexOf('chacha20') < merged.indexOf('WARN'), merged.join(','));
  assert.ok(merged.indexOf('blowfish') > merged.indexOf('WARN'), merged.join(','));
  assert.ok(merged.indexOf('arcfour') > merged.indexOf('WARN'), merged.join(','));

  // A stored list with no marker at all still gets one.
  assert.ok(adv.mergeAlgorithmOrder(['aes'], adv.CIPHERS).includes('WARN'));

  // An unknown stored entry is dropped rather than rendered as a mystery row,
  // and a catalogue with no warning line never grows one.
  assert.deepStrictEqual(adv.mergeAlgorithmOrder(['nonsense'], adv.GSS_LIBRARIES, { noWarn: true }),
    ['gssapi32', 'sspi', 'custom']);
  assert.ok(!adv.mergeAlgorithmOrder([], adv.GSS_LIBRARIES, { noWarn: true }).includes('WARN'));

  // Every list is a permutation of the catalogue: no duplicates, nothing lost.
  for (const catalogue of [adv.CIPHERS, adv.KEX_ALGORITHMS, adv.HOST_KEY_ALGORITHMS]) {
    const out = adv.mergeAlgorithmOrder([], catalogue);
    assert.strictEqual(new Set(out).size, out.length, 'duplicate entry');
    assert.strictEqual(out.length, catalogue.length);
  }
});

test('the algorithm catalogues match WinSCP’s own name lists', async () => {
  const { adv } = await modules;
  assert.deepStrictEqual(adv.CIPHERS.map(([id]) => id).sort(),
    ['3des', 'WARN', 'aes', 'aesgcm', 'arcfour', 'blowfish', 'chacha20', 'des']);
  assert.deepStrictEqual(adv.HOST_KEY_ALGORITHMS.map(([id]) => id).sort(),
    ['WARN', 'dsa', 'ecdsa', 'ed25519', 'ed448', 'rsa']);
  assert.deepStrictEqual(adv.GSS_LIBRARIES.map(([id]) => id), ['gssapi32', 'sspi', 'custom']);
  assert.strictEqual(adv.KEX_ALGORITHMS.length, 13);
  assert.strictEqual(adv.S3_REGIONS.length, 38);
});

test('describeValue never reveals a stored secret', async () => {
  const { adv } = await modules;
  const control = { kind: 'secret', key: 'encryptKey' };
  assert.strictEqual(adv.describeValue(control, { encryptKey: 'a-real-key-value' }), 'stored');
  assert.strictEqual(adv.describeValue(control, { encryptKey: '' }), 'not set');
  const text = adv.searchTextOf({ ...control, label: 'Encryption key' }, { encryptKey: 'a-real-key-value' });
  assert.ok(!text.includes('a-real-key-value'), text);
});

test('getSiteKey and setSiteKey walk the dotted bug keys', async () => {
  const { adv } = await modules;
  const site = await siteOf({});
  assert.strictEqual(adv.getSiteKey(site, 'sshBugs.rekey2'), 'auto');
  adv.setSiteKey(site, 'sshBugs.rekey2', 'on');
  assert.strictEqual(site.sshBugs.rekey2, 'on');
  adv.setSiteKey(site, 'brandNew.deep.key', 5);
  assert.strictEqual(site.brandNew.deep.key, 5);
});
