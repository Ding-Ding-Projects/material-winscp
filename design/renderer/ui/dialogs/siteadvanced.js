// ui/dialogs/siteadvanced.js — Advanced Site Settings (SiteAdvanced.dfm).
//
// Eighteen pages, every control the original has, each one bound to its key in
// SESSION_DEFAULTS. The page/control table below is transcribed from
// design/renderer/forms.json — which was extracted from WinSCP's own .dfm
// files — so the captions, the combo items and the grouping are the original's
// rather than anyone's memory of them.
//
// Three rules this dialog holds to:
//
//   * NOTHING VANISHES. A page that does not apply to the chosen protocol is
//     still listed and still shows its controls; it is disabled with the reason
//     written on it. WinSCP hides those pages from its navigation tree, but a
//     setting a user cannot find is a setting they think they have lost.
//   * A GAP IS NAMED, NOT HIDDEN. Options whose backing capability is listed in
//     docs/protocol-gaps.md render normally, keep the user's value and carry a
//     notice saying exactly what does and does not happen today. Silently
//     dropping the value would be worse than either.
//   * EVERY PAGE IS SEARCHABLE. Each page carries its own createSearchBar over
//     that page's labels, descriptions and current values, and says plainly
//     when a match is sitting on a different page — with a button to go there.
//
// Reference: vendor/winscp/source/forms/SiteAdvanced.{dfm,cpp} (LoadSession,
// SaveSession, UpdateControls) and vendor/winscp/source/core/SessionData.cpp.

import { h, icon, clear, uid, appearanceTarget, announce } from '../../dom.js';
import { t, bindText } from '../../i18n.js';
import { api } from '../../state.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import { openMenu } from '../contextmenu.js';
import {
  SESSION_DEFAULTS, SECRET_SENTINEL, SECRET_FIELDS, protocolInfo,
  installSessionDialogStyles, stripSecrets,
} from './sitetree.js';

/* ================================================================== */
/* value tables                                                        */
/* ================================================================== */

/** VCLCommon.cpp ComboAutoSwitchInitialize: Auto, Off, On — in that order. */
export const AUTO_SWITCH = [['auto', 'Auto'], ['off', 'Off'], ['on', 'On']];

/** core/SessionData.cpp CipherNames + TextsWin1.rc CIPHER_NAME_*. */
export const CIPHERS = [
  ['aesgcm', 'AES-GCM'], ['aes', 'AES'], ['chacha20', 'ChaCha20'], ['3des', '3DES'],
  ['WARN', '-- warn below here --'],
  ['des', 'DES'], ['blowfish', 'Blowfish'], ['arcfour', 'Arcfour'],
];

/** core/SessionData.cpp KexNames + TextsWin1.rc KEX_NAME_*. */
export const KEX_ALGORITHMS = [
  ['mlkem-nist', 'ML-KEM / NIST ECDH hybrid kex'],
  ['mlkem-curve25519', 'ML-KEM / Curve25519 hybrid kex'],
  ['ntru-curve25519', 'NTRU Prime / Curve25519 hybrid kex'],
  ['ecdh', 'ECDH key exchange'],
  ['dh-gex-sha1', 'Diffie-Hellman group exchange'],
  ['dh-group18-sha512', 'Diffie-Hellman group 18 (8192-bit)'],
  ['dh-group17-sha512', 'Diffie-Hellman group 17 (6144-bit)'],
  ['dh-group16-sha512', 'Diffie-Hellman group 16 (4096-bit)'],
  ['dh-group15-sha512', 'Diffie-Hellman group 15 (3072-bit)'],
  ['dh-group14-sha1', 'Diffie-Hellman group 14 (2048-bit)'],
  ['rsa', 'RSA-based key exchange'],
  ['WARN', '-- warn below here --'],
  ['dh-group1-sha1', 'Diffie-Hellman group 1 (1024-bit)'],
];

/** core/SessionData.cpp HostKeyNames. */
export const HOST_KEY_ALGORITHMS = [
  ['ed448', 'Ed448'], ['ed25519', 'Ed25519'], ['ecdsa', 'ECDSA'], ['rsa', 'RSA'],
  ['WARN', '-- warn below here --'],
  ['dsa', 'DSA'],
];

/** putty/windows/gss.c gsslibnames, in gsslibkeywords order. */
export const GSS_LIBRARIES = [
  ['gssapi32', 'MIT Kerberos GSSAPI32.DLL'],
  ['sspi', 'Microsoft SSPI SECUR32.DLL'],
  ['custom', 'User-specified GSSAPI DLL'],
];

/** S3DefaultReqionCombo's items, verbatim from the .dfm. */
export const S3_REGIONS = [
  'af-south-1', 'ap-east-1', 'ap-east-2', 'ap-northeast-1', 'ap-northeast-2',
  'ap-northeast-3', 'ap-south-1', 'ap-south-2', 'ap-southeast-1', 'ap-southeast-2',
  'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-6',
  'ap-southeast-7', 'ca-central-1', 'ca-west-1', 'cn-north-1', 'cn-northwest-1',
  'eu-central-1', 'eu-central-2', 'eu-north-1', 'eu-south-1', 'eu-south-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'il-central-1', 'me-central-1',
  'me-south-1', 'mx-central-1', 'sa-east-1', 'us-east-1', 'us-east-2',
  'us-gov-east-1', 'us-gov-west-1', 'us-west-1', 'us-west-2',
];

const TLS_VERSIONS = [['tls10', 'TLS 1.0'], ['tls11', 'TLS 1.1'], ['tls12', 'TLS 1.2'], ['tls13', 'TLS 1.3']];

/** SshProxyMethodCombo / NeonProxyMethodCombo / FtpProxyMethodCombo items. */
const SSH_PROXY_METHODS = [
  ['none', 'None'], ['socks4', 'SOCKS4'], ['socks5', 'SOCKS5'],
  ['http', 'HTTP'], ['telnet', 'Telnet'], ['cmd', 'Local'],
];
const NEON_PROXY_METHODS = [['none', 'None'], ['socks4', 'SOCKS4'], ['socks5', 'SOCKS5'], ['http', 'HTTP']];
const FTP_PROXY_LOGON_TYPES = [
  'SITE %host',
  'USER %proxyuser, USER %user@%host',
  'OPEN %host',
  'USER %proxyuser, USER %user',
  'USER %user@%host',
  'USER %proxyuser@%host',
  'USER %user@%host %proxyuser',
  'USER %user@%proxyuser@%host',
];

/**
 * Options whose backing capability is a known gap. The text is the consequence
 * for the user, taken from docs/protocol-gaps.md — never "library X lacks
 * function Y", which tells a user nothing about what they can do.
 */
const GAPS = {
  authGSSAPI: 'GSSAPI/Kerberos is not implemented by this port’s SSH engine. The setting is stored and sent to the session, which logs a warning and continues with the other authentication methods. Single sign-on against a Kerberos realm does not work today.',
  authGSSAPIKEX: 'GSSAPI key exchange is not implemented by this port’s SSH engine. The setting is stored; the session logs that it was not offered.',
  gssapiFwdTGT: 'Credential delegation needs GSSAPI, which this port’s SSH engine does not implement. The value is kept for when it does.',
  gssLibList: 'The GSSAPI library order is stored but has no effect yet: no GSSAPI mechanism is implemented. Your order is preserved so it applies the moment one is.',
  sftpMaxVersion: 'The SFTP client negotiates version 3 only. Versions 4–6 and the workarounds that go with them have no effect today; the value is kept.',
  sftpDownloadQueue: 'Request pipelining depth is not configurable in this port’s SFTP engine, which issues one request at a time on the streaming path. Throughput on a high-latency link is lower than the original’s. The value is stored and reported in the log rather than silently ignored.',
  sftpUploadQueue: 'Request pipelining depth is not configurable in this port’s SFTP engine. The value is stored and reported in the log rather than silently ignored.',
  sftpBugs: 'These workarounds apply to SFTP versions 4 and above, which this port does not negotiate yet. They are stored and will apply when it does.',
  ftpTransferActiveImmediately: 'Not yet threaded through to the FTP adapter. The value is stored; it does not change how the data connection is opened today.',
  ftpDupFF: 'Not yet threaded through to the FTP adapter. The value is stored.',
  ftpUndupFF: 'Not yet threaded through to the FTP adapter. The value is stored.',
  proxyMethodSystem: 'There is no reliable way to read the Windows system proxy configuration from this runtime, so "system" is not offered. Choose the proxy explicitly — connecting direct while the user believed a proxy was in use would be a privacy failure, not a convenience.',
  codePage: 'Code pages outside this runtime’s built-in set fall back to Latin-1, which preserves the bytes of a file name rather than mangling it. A Big5 or GB18030 name still needs an encoding table.',
};

/* ================================================================== */
/* the page/control table                                              */
/* ================================================================== */
//
// `level` mirrors the .dfm's TTabSheet.Tag: 1 is a top-level navigation entry,
// 2 is indented under the previous one.

/** Shorthand builders keep the table readable. */
const check = (id, key, label, extra = {}) => ({ id, kind: 'check', key, label, ...extra });
const text = (id, key, label, extra = {}) => ({ id, kind: 'text', key, label, ...extra });
const secret = (id, key, label, extra = {}) => ({ id, kind: 'secret', key, label, ...extra });
const number = (id, key, label, extra = {}) => ({ id, kind: 'number', key, label, min: 0, max: 99999, ...extra });
const select = (id, key, label, options, extra = {}) => ({ id, kind: 'select', key, label, options, ...extra });
const autoswitch = (id, key, label, extra = {}) => ({ id, kind: 'select', key, label, options: AUTO_SWITCH, ...extra });
const combo = (id, key, label, suggestions, extra = {}) => ({ id, kind: 'combo', key, label, suggestions, ...extra });
const memo = (id, key, label, extra = {}) => ({ id, kind: 'memo', key, label, ...extra });
const radios = (id, key, label, options, extra = {}) => ({ id, kind: 'radios', key, label, options, ...extra });
const filename = (id, key, label, extra = {}) => ({ id, kind: 'filename', key, label, ...extra });
const orderlist = (id, key, label, catalogue, extra = {}) => ({ id, kind: 'orderlist', key, label, catalogue, ...extra });
const staticText = (id, label) => ({ id, kind: 'static', label });
const button = (id, label, onSelect, extra = {}) => ({ id, kind: 'button', label, onSelect, ...extra });

export const SITE_ADVANCED_PAGES = [
  /* ---------------------------------------------------------------- */
  {
    id: 'environment', caption: 'Environment', level: 1, icon: 'language',
    groups: [
      {
        id: 'EnvironmentGroup', caption: 'Server environment',
        controls: [
          select('EOLTypeCombo', 'eolType', 'End-of-line characters (if not indicated by server):',
            [['lf', 'LF'], ['crlf', 'CR/LF']],
            { enabled: (c) => c.sftp || c.scp }),
          autoswitch('UtfCombo', 'utf', 'UTF-8 encoding for filenames:',
            { enabled: (c) => c.sftp || c.scp || c.ftp }),
          {
            id: 'TimeDifferenceEdit', kind: 'timezone', key: 'timeDifference',
            label: 'Time zone offset:',
            hint: 'Hours and minutes added to every remote timestamp. Used when a server reports local time without saying which zone it is in.',
            enabled: (c) => c.scp || (c.ftp && c.site.ftpUseMlsd === 'off' && !c.site.timeDifferenceAuto),
          },
          check('TimeDifferenceAutoCheck', 'timeDifferenceAuto', 'Detect automatically',
            { enabled: (c) => c.ftp && c.site.ftpUseMlsd === 'off' }),
          check('TrimVMSVersionsCheck', 'trimVMSVersions', 'Trim VMS version numbers',
            { enabled: (c) => !c.s3 }),
        ],
      },
      {
        id: 'DSTModeGroup', caption: 'Daylight saving time',
        enabled: (c) => c.sftp || c.scp,
        controls: [
          radios('DSTModeGroupRadios', 'dSTMode', 'Timestamp handling', [
            ['unix', 'Adjust remote timestamp to local conventions'],
            ['keep', 'Preserve remote timestamp exactly as the server reports it'],
            ['win', 'Adjust remote timestamp with DST'],
          ], {
            hint: 'The middle option has no control in the original dialog, but the setting has three values; offering only two would silently change a site that already uses it.',
          }),
        ],
      },
      {
        id: 'PuttyGroup', caption: 'PuTTY',
        controls: [
          text('PuttySettingsEdit', 'puttySettings', 'PuTTY terminal settings:',
            { hint: 'The name of a saved PuTTY session whose terminal settings are used when this site is opened in PuTTY.' }),
          button('PuttySettingsButton', 'Edit in PuTTY…', (ctx) => ctx.runAction('editInPutty')),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'directories', caption: 'Directories', level: 2, icon: 'folder',
    groups: [
      {
        id: 'DirectoriesGroup', caption: 'Directories',
        controls: [
          { id: 'LocalDirectoryEdit', kind: 'directory', key: 'localDirectory', label: 'Local directory:' },
          staticText('LocalDirectoryDescLabel', 'Local directory is not used with the Explorer interface.'),
          text('RemoteDirectoryEdit', 'remoteDirectory', 'Remote directory:'),
          check('UpdateDirectoriesCheck', 'updateDirectories', 'Remember last used directory'),
          check('SynchronizeBrowsingCheck', 'synchronizeBrowsing', 'Synchronize browsing',
            { enabled: (c) => c.prefs.interface !== 'explorer' }),
        ],
      },
      {
        id: 'DirectoryOptionsGroup', caption: 'Directory reading options',
        controls: [
          check('CacheDirectoriesCheck', 'cacheDirectories', 'Cache visited remote directories'),
          check('CacheDirectoryChangesCheck', 'cacheDirectoryChanges', 'Cache directory changes',
            { enabled: (c) => !c.scp || c.site.cacheDirectories }),
          check('PreserveDirectoryChangesCheck', 'preserveDirectoryChanges', 'Permanent cache',
            { enabled: (c) => c.site.cacheDirectoryChanges && (!c.scp || c.site.cacheDirectories) }),
          check('ResolveSymlinksCheck', 'resolveSymlinks', 'Resolve symbolic links',
            { enabled: (c) => c.sftp || c.scp }),
          check('FollowDirectorySymlinksCheck', 'followDirectorySymlinks', 'Follow symbolic links to directories',
            { enabled: (c) => c.sftp || c.scp || c.ftp }),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'recyclebin', caption: 'Recycle bin', level: 2, icon: 'delete',
    groups: [
      {
        id: 'RecycleBinGroup', caption: 'Recycle bin',
        controls: [
          check('DeleteToRecycleBinCheck', 'deleteToRecycleBin', 'Preserve deleted remote files to recycle bin'),
          check('OverwrittenToRecycleBinCheck', 'overwrittenToRecycleBin', 'Preserve overwritten remote files to recycle bin (SFTP only)',
            { enabled: (c) => c.sftp }),
          text('RecycleBinPathEdit', 'recycleBinPath', 'Remote recycle bin:',
            { enabled: (c) => c.site.deleteToRecycleBin || (c.sftp && c.site.overwrittenToRecycleBin) }),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'encryption', caption: 'Encryption', level: 2, icon: 'shield_lock',
    enabled: (c) => c.sftp,
    disabledReason: 'File encryption at rest is available on SFTP sessions only.',
    groups: [
      {
        id: 'EncryptFilesRoot', caption: '',
        controls: [check('EncryptFilesCheck', 'encryptFiles', 'Encrypt files')],
      },
      {
        id: 'EncryptFilesGroup', caption: 'Encryption options',
        enabled: (c) => c.site.encryptFiles,
        controls: [
          secret('EncryptKeyEdit', 'encryptKey', 'Encryption key:', {
            reveal: 'ShowEncryptionKeyCheck',
            hint: 'A 256-bit key, base64 encoded. Files are encrypted with it before upload and decrypted after download. Lose the key and the files cannot be recovered — nothing else holds a copy.',
          }),
          button('GenerateKeyButton', 'Generate Key', (ctx) => ctx.runAction('generateEncryptionKey')),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'sftp', caption: 'SFTP', level: 2, icon: 'shield_lock',
    enabled: (c) => c.sftp,
    disabledReason: 'These options apply to SFTP sessions only.',
    groups: [
      {
        id: 'SFTPProtocolGroup', caption: 'Protocol options',
        controls: [
          select('SFTPMaxVersionCombo', 'sftpMaxVersion', 'Preferred SFTP protocol version:',
            [['auto', 'Auto'], [0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']],
            { gap: 'sftpMaxVersion', numeric: true }),
          combo('SftpServerEdit', 'sftpServer', 'SFTP server:',
            ['', '/bin/sftp-server', 'sudo su -c /bin/sftp-server'],
            { placeholder: 'Default', hint: 'The command the server runs for the SFTP subsystem. Leave empty to use the server’s own default.' }),
          autoswitch('SFTPRealPathCombo', 'sftpRealPath', 'Canonicalize paths on the server'),
          check('UsePosixRenameCheck', 'usePosixRename', 'Use POSIX rename'),
        ],
      },
      {
        id: 'SFTPBugsGroupBox', caption: 'Detection of known bugs in SFTP servers',
        gap: 'sftpBugs',
        controls: [
          autoswitch('SFTPBugSymlinkCombo', 'sftpBugs.symlink', 'Reverses order of link command arguments:'),
          autoswitch('SFTPBugSignedTSCombo', 'sftpBugs.signedTS', 'Misinterprets file timestamps prior to 1970:'),
        ],
      },
      {
        id: 'SFTPPerformanceGroup', caption: 'Performance',
        controls: [
          number('SFTPMinPacketSizeEdit', 'sftpMinPacketSize', 'Minimum SFTP packet size:', { max: 1048576, unit: 'bytes' }),
          number('SFTPMaxPacketSizeEdit', 'sftpMaxPacketSize', 'Maximum SFTP packet size:', { max: 1048576, unit: 'bytes', hint: '0 uses the engine’s own read size. This value maps onto the stream high-water mark, which genuinely is the SFTP read packet size here.' }),
          number('SFTPDownloadQueueEdit', 'sftpDownloadQueue', 'Download pipelining depth:', { max: 256, gap: 'sftpDownloadQueue' }),
          number('SFTPUploadQueueEdit', 'sftpUploadQueue', 'Upload pipelining depth:', { max: 256, gap: 'sftpUploadQueue' }),
          number('SFTPListingQueueEdit', 'sftpListingQueue', 'Listing pipelining depth:', { max: 256 }),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'scp', caption: 'SCP/Shell', level: 2, icon: 'terminal',
    enabled: (c) => c.ssh,
    disabledReason: 'Shell options apply to SSH sessions (SFTP and SCP) only.',
    groups: [
      {
        id: 'ShellGroup', caption: 'Shell',
        controls: [
          combo('ShellEdit', 'shell', 'Shell:', ['', '/bin/bash', '/bin/ksh', '/bin/sh', 'sudo su -'],
            { placeholder: 'Default' }),
          combo('ReturnVarEdit', 'returnVar', 'Return code variable:', ['', '?', 'status'],
            { placeholder: 'Autodetect' }),
        ],
      },
      {
        id: 'ScpLsOptionsGroup', caption: 'Directory listing',
        visible: (c) => c.scp,
        controls: [
          combo('ListingCommandEdit', 'listingCommand', 'Listing command:', ['ls -la', 'ls -gla']),
          check('IgnoreLsWarningsCheck', 'ignoreLsWarnings', 'Ignore LS warnings'),
          { id: 'SCPLsFullTimeAutoCheck', kind: 'tricheck', key: 'sCPLsFullTime', label: 'Try to get full timestamp' },
        ],
      },
      {
        id: 'OtherShellOptionsGroup', caption: 'Other options',
        visible: (c) => c.scp,
        controls: [
          { id: 'LookupUserGroupsCheck', kind: 'tricheck', key: 'lookupUserGroups', label: 'Lookup user groups' },
          check('ClearAliasesCheck', 'clearAliases', 'Clear aliases'),
          check('UnsetNationalVarsCheck', 'unsetNationalVars', 'Clear national variables'),
          check('Scp1CompatibilityCheck', 'scp1Compatibility', 'Use scp2 with scp1 compatibility'),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'ftp', caption: 'FTP', level: 2, icon: 'lan',
    enabled: (c) => c.ftp,
    disabledReason: 'These options apply to FTP sessions only.',
    groups: [
      {
        id: 'FtpGroup', caption: 'Protocol options',
        controls: [
          memo('PostLoginCommandsMemo', 'postLoginCommands', 'Post login commands:',
            { lines: true, hint: 'One raw FTP command per line, sent after a successful login.' }),
          autoswitch('FtpListAllCombo', 'ftpListAll', 'Support for listing of hidden files:',
            { enabled: (c) => c.site.ftpUseMlsd === 'off' }),
          autoswitch('FtpUseMlsdCombo', 'ftpUseMlsd', 'Use MLSD command for directory listing'),
          autoswitch('FtpForcePasvIpCombo', 'ftpForcePasvIp', 'Force IP address for passive mode connections:',
            { enabled: (c) => c.site.ftpPasvMode && c.site.addressFamily !== 'ipv6' }),
          text('FtpAccountEdit', 'ftpAccount', 'Account:',
            { hint: 'Sent with the ACCT command by servers that ask for one after the password.' }),
          autoswitch('FtpHostCombo', 'ftpHost', 'Use HOST command to select host on the server'),
          check('VMSAllRevisionsCheck', 'vMSAllRevisions', 'Display all file revisions on VMS servers'),
        ],
      },
      {
        id: 'FtpCompatibilityGroup', caption: 'Compatibility',
        controls: [
          autoswitch('FtpTransferActiveImmediatelyCombo', 'ftpTransferActiveImmediately',
            'Start active-mode transfer immediately', { gap: 'ftpTransferActiveImmediately' }),
          check('FtpDupFFCheck', 'ftpDupFF', 'Server duplicates the 0xFF byte in file names', { gap: 'ftpDupFF' }),
          check('FtpUndupFFCheck', 'ftpUndupFF', 'Undo the server’s 0xFF duplication', { gap: 'ftpUndupFF' }),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 's3', caption: 'S3', level: 2, icon: 'database',
    enabled: (c) => c.s3,
    disabledReason: 'These options apply to Amazon S3 sessions only.',
    groups: [
      {
        id: 'S3Group', caption: 'Protocol options',
        controls: [
          combo('S3DefaultReqionCombo', 's3DefaultRegion', 'Default region:', ['', ...S3_REGIONS],
            { placeholder: 'Detected from the endpoint' }),
          select('S3UrlStyleCombo', 's3UrlStyle', 'URL style:',
            [['virtualhost', 'Virtual Host'], ['path', 'Path']]),
          check('S3RequesterPaysCheck', 's3RequesterPays', 'Requester pays'),
          combo('S3MaxKeysCombo', 's3MaxKeys', 'Maximum keys per listing request:', ['auto', '100', '500', '1000'],
            { hint: 'Auto lets the endpoint choose. Lower it for a bucket whose listings time out.' }),
          combo('S3StorageClassCombo', 's3StorageClass', 'Storage class for new objects:',
            ['', 'STANDARD', 'STANDARD_IA', 'ONEZONE_IA', 'INTELLIGENT_TIERING', 'GLACIER_IR', 'GLACIER', 'DEEP_ARCHIVE', 'REDUCED_REDUNDANCY'],
            { placeholder: 'The bucket’s default' }),
        ],
      },
      {
        id: 'S3AuthenticationGroup', caption: 'Authentication',
        controls: [
          secret('S3SessionTokenMemo', 's3SessionToken', 'Session token:', {
            multiline: true,
            enabled: (c) => !c.site.s3CredentialsEnv,
            hint: 'A temporary STS token. Leave empty for long-lived access keys.',
          }),
          text('S3RoleArnEdit', 's3RoleArn', 'Role ARN:',
            { enabled: (c) => !c.site.s3CredentialsEnv }),
          text('S3ProfileEdit', 's3Profile', 'AWS profile:',
            { enabled: (c) => c.site.s3CredentialsEnv, hint: 'The profile name in the AWS shared credentials file.' }),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'webdav', caption: 'WebDAV', level: 2, icon: 'cloud',
    enabled: (c) => c.webdav,
    disabledReason: 'These options apply to WebDAV sessions only.',
    groups: [
      {
        id: 'WebdavGroup', caption: 'Protocol options',
        controls: [
          check('WebDavLiberalEscapingCheck', 'webDavLiberalEscaping', 'Tolerate non-encoded special characters in filenames'),
          check('WebDavCrossDomainRedirectsCheck', 'webDavCrossDomainRedirects', 'Allow redirects to other hosts',
            { hint: 'Off by default: following a redirect to another host sends your credentials there.' }),
          check('WebDavAuthLegacyCheck', 'webDavAuthLegacy', 'Send credentials before the server asks (legacy servers)',
            {
              hint: 'Sends Basic authentication pre-emptively. Only for a server that rejects the challenge-response exchange.',
              warning: 'Warning: when enabled, credentials are sent before the server proves it wants them. Use this only with a trusted WebDAV endpoint, preferably over HTTPS.',
            }),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'connection', caption: 'Connection', level: 1, icon: 'sync_alt',
    groups: [
      {
        id: 'TimeoutGroup', caption: 'Timeouts',
        controls: [number('TimeoutEdit', 'timeout', 'Server response timeout:', { min: 1, max: 3600, unit: 'seconds' })],
      },
      {
        id: 'PingGroup', caption: 'Keepalives',
        visible: (c) => !c.ftp,
        enabled: (c) => c.ssh,
        controls: [
          radios('PingTypeRadios', 'pingType', 'Keepalive method', [
            ['off', 'Off'],
            ['null', 'Sending of null SSH packets'],
            ['dummy', 'Executing dummy protocol commands'],
          ]),
          number('PingIntervalSecEdit', 'pingInterval', 'Seconds between keepalives:',
            { min: 1, max: 86400, unit: 'seconds', enabled: (c) => c.ssh && c.site.pingType !== 'off' }),
        ],
      },
      {
        id: 'FtpPingGroup', caption: 'Keepalives',
        visible: (c) => c.ftp,
        controls: [
          radios('FtpPingTypeRadios', 'ftpPingType', 'Keepalive method', [
            ['off', 'Off'],
            ['dummy', 'Executing dummy protocol commands'],
            ['directory', 'And additionally reading the current directory'],
          ]),
          number('FtpPingIntervalSecEdit', 'ftpPingInterval', 'Seconds between keepalives:',
            { min: 1, max: 86400, unit: 'seconds', enabled: (c) => c.site.ftpPingType !== 'off' }),
        ],
      },
      {
        id: 'IPvGroup', caption: 'Internet protocol version',
        enabled: (c) => c.ssh || c.ftp,
        controls: [
          radios('IPvRadios', 'addressFamily', 'Address family', [
            ['auto', 'Auto'], ['ipv4', 'IPv4'], ['ipv6', 'IPv6'],
          ], { optionEnabled: (value, c) => (value === 'auto' ? c.ssh : true) }),
        ],
      },
      {
        id: 'ConnectionGroup', caption: 'Connection',
        controls: [
          check('FtpPasvModeCheck', 'ftpPasvMode', 'Passive mode', { enabled: (c) => c.ftp }),
          {
            id: 'BufferSizeCheck', kind: 'checkNumber', key: 'sendBuf',
            label: 'Optimize connection buffer size', onValue: 262144, offValue: 0,
            enabled: (c) => c.ssh || c.ftp || c.s3,
          },
          combo('CodePageCombo', 'codePage', 'Remote character set:',
            ['UTF-8', 'ISO-8859-1', 'windows-1252', 'Big5', 'GB18030', 'Shift_JIS'], { gap: 'codePage' }),
          text('SourceAddressEdit', 'sourceAddress', 'Local address to bind to:'),
          text('ProtocolFeaturesEdit', 'protocolFeatures', 'Protocol feature overrides:',
            { hint: 'A space-separated list of features to force on (+name) or off (-name) instead of detecting them.' }),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'proxy', caption: 'Proxy', level: 2, icon: 'lan',
    groups: [
      {
        id: 'ProxyTypeGroup', caption: 'Proxy',
        controls: [
          { id: 'ProxyMethodCombo', kind: 'proxymethod', key: 'proxyMethod', label: 'Proxy type:' },
          {
            id: 'FtpProxyLogonTypeCombo', kind: 'select', key: 'ftpProxyLogonType',
            label: 'FTP proxy login sequence:', numeric: true,
            options: [[0, 'Not used'], ...FTP_PROXY_LOGON_TYPES.map((label, i) => [i + 1, label])],
            visible: (c) => c.ftp,
            enabled: (c) => c.ftp && c.site.proxyMethod !== 'none',
          },
          text('ProxyHostEdit', 'proxyHost', 'Proxy hostname:', { enabled: (c) => proxyNeedsHost(c) }),
          number('ProxyPortEdit', 'proxyPort', 'Port number:', { max: 65535, enabled: (c) => proxyNeedsHost(c) }),
          text('ProxyUsernameEdit', 'proxyUsername', 'Username:', { enabled: (c) => proxyNeedsUser(c) }),
          secret('ProxyPasswordEdit', 'proxyPassword', 'Password:', { enabled: (c) => proxyNeedsPassword(c) }),
          button('ProxyAutodetectButton', 'Autodetect', (ctx) => ctx.runAction('autodetectProxy'),
            { hint: GAPS.proxyMethodSystem }),
        ],
      },
      {
        id: 'ProxySettingsGroup', caption: 'Proxy settings',
        visible: (c) => c.ssh,
        enabled: (c) => c.ssh && c.site.proxyMethod !== 'none',
        controls: [
          text('ProxyTelnetCommandEdit', 'proxyTelnetCommand', 'Telnet command:',
            { visible: (c) => c.site.proxyMethod !== 'cmd', enabled: (c) => c.site.proxyMethod === 'telnet' }),
          staticText('ProxyTelnetCommandHintText', 'Patterns: %host %port %user %pass — substituted before the command is sent.'),
          text('ProxyLocalCommandEdit', 'proxyLocalCommand', 'Local proxy command:',
            { visible: (c) => c.site.proxyMethod === 'cmd' }),
          staticText('ProxyLocalCommandHintText', 'Patterns: %host %port %user %pass %proxyhost %proxyport.'),
          button('ProxyLocalCommandBrowseButton', 'Browse…', (ctx) => ctx.runAction('browseProxyCommand'),
            { visible: (c) => c.site.proxyMethod === 'cmd' }),
          select('ProxyDNSCombo', 'proxyDNS', 'Do DNS name lookup at proxy end:',
            [['auto', 'Auto'], ['off', 'No'], ['on', 'Yes']]),
          check('ProxyLocalhostCheck', 'proxyLocalhost', 'Consider proxying local host connections'),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'tunnel', caption: 'Tunnel', level: 2, icon: 'swap_horiz',
    enabled: (c) => c.ssh,
    disabledReason: 'A tunnel is opened over SSH, so it applies to SFTP and SCP sessions only.',
    groups: [
      {
        id: 'TunnelRoot', caption: '',
        controls: [check('TunnelCheck', 'tunnel', 'Connect through SSH tunnel')],
      },
      {
        id: 'TunnelSessionGroup', caption: 'Host to setup tunnel on',
        enabled: (c) => c.site.tunnel,
        controls: [
          text('TunnelHostNameEdit', 'tunnelHostName', 'Hostname:'),
          number('TunnelPortNumberEdit', 'tunnelPortNumber', 'Port number:', { min: 1, max: 65535 }),
          text('TunnelUserNameEdit', 'tunnelUserName', 'Username:'),
          secret('TunnelPasswordEdit', 'tunnelPassword', 'Password:'),
        ],
      },
      {
        id: 'TunnelOptionsGroup', caption: 'Tunnel options',
        enabled: (c) => c.site.tunnel,
        controls: [
          combo('TunnelLocalPortNumberEdit', 'tunnelLocalPortNumber', 'Local tunnel port:', ['0'],
            { placeholder: 'Autoselect', numeric: true, hint: '0 lets the operating system pick a free port.' }),
        ],
      },
      {
        id: 'TunnelAuthenticationParamsGroup', caption: 'Tunnel authentication parameters',
        enabled: (c) => c.site.tunnel,
        controls: [
          filename('TunnelPrivateKeyEdit3', 'tunnelPublicKeyFile', 'Private key file:'),
          secret('TunnelPassphraseEdit', 'tunnelPassphrase', 'Key passphrase:'),
          text('TunnelHostKeyEdit', 'tunnelHostKey', 'Expected host key fingerprint:'),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'tls', caption: 'TLS/SSL', level: 2, icon: 'shield_lock',
    enabled: (c) => (c.ftp || c.webdav || c.s3) && c.site.ftps !== 'none',
    disabledReason: 'TLS options apply when the session actually uses TLS. Choose an encryption on the login form first.',
    groups: [
      {
        id: 'TlsGroup', caption: 'TLS options',
        controls: [
          select('MinTlsVersionCombo', 'minTlsVersion', 'Minimum TLS version:', TLS_VERSIONS),
          select('MaxTlsVersionCombo', 'maxTlsVersion', 'Maximum TLS version:', TLS_VERSIONS),
          check('SslSessionReuseCheck2', 'sslSessionReuse', 'Reuse TLS session ID for data connections',
            { enabled: (c) => c.ftp, hint: 'Required by servers that refuse a data connection whose TLS session does not match the control connection’s.' }),
        ],
      },
      {
        id: 'TlsAuthenticationGroup', caption: 'Authentication parameters',
        visible: (c) => c.ftp || c.webdav,
        controls: [filename('TlsCertificateFileEdit', 'tlsCertificateFile', 'Client certificate file:')],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'ssh', caption: 'SSH', level: 1, icon: 'key',
    enabled: (c) => c.ssh,
    disabledReason: 'SSH options apply to SFTP and SCP sessions only.',
    groups: [
      {
        id: 'ProtocolGroup', caption: 'Protocol options',
        controls: [check('CompressionCheck', 'compression', 'Enable compression')],
      },
      {
        id: 'EncryptionGroup', caption: 'Encryption options',
        controls: [
          orderlist('CipherListBox', 'cipherList', 'Encryption cipher selection policy:', CIPHERS,
            { unsupported: ['des', 'blowfish', 'arcfour'] }),
          check('Ssh2LegacyDESCheck', 'ssh2DES', 'Enable legacy use of single-DES',
            { hint: 'Single-DES is broken. It exists for a device too old to speak anything else.' }),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'kex', caption: 'Key exchange', level: 2, icon: 'sync_alt',
    enabled: (c) => c.ssh,
    disabledReason: 'Key exchange applies to SSH sessions only.',
    groups: [
      {
        id: 'KexOptionsGroup', caption: 'Key exchange algorithm options',
        controls: [
          orderlist('KexListBox', 'kexList', 'Algorithm selection policy:', KEX_ALGORITHMS,
            { unsupported: ['rsa'] }),
          check('AuthGSSAPIKEXCheck', 'authGSSAPIKEX', 'Attempt GSSAPI key exchange', { gap: 'authGSSAPIKEX' }),
        ],
      },
      {
        id: 'HostKeyGroup', caption: 'Host key algorithm options',
        controls: [
          orderlist('HostKeyListBox', 'hostKeyList', 'Host key selection policy:', HOST_KEY_ALGORITHMS,
            { unsupported: ['ed448'] }),
        ],
      },
      {
        id: 'KexReexchangeGroup', caption: 'Options controlling key re-exchange',
        enabled: (c) => c.site.sshBugs?.rekey2 !== 'on',
        controls: [
          number('RekeyTimeEdit', 'rekeyTime', 'Max minutes before rekey (0 for no limit):', { max: 1440, unit: 'minutes' }),
          text('RekeyDataEdit', 'rekeyData', 'Max data before rekey (0 for no limit):',
            { hint: 'A byte count with an optional K, M or G suffix, for example 1G.' }),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'authentication', caption: 'Authentication', level: 2, icon: 'shield_lock',
    enabled: (c) => c.ssh,
    disabledReason: 'These authentication options apply to SSH sessions only.',
    groups: [
      {
        id: 'AuthRoot', caption: '',
        controls: [
          check('SshNoUserAuthCheck', 'sshNoUserAuth', 'Bypass authentication entirely',
            { hint: 'For a server that grants access without authenticating at all. The user name and password fields on the login form go quiet while this is on.' }),
        ],
      },
      {
        id: 'AuthenticationGroup', caption: 'Authentication options',
        enabled: (c) => !c.site.sshNoUserAuth,
        controls: [
          check('TryAgentCheck2', 'tryAgent', 'Attempt authentication using agent'),
          check('AuthKICheck', 'authKI', 'Attempt keyboard-interactive authentication'),
          check('AuthKIPasswordCheck', 'authKIPassword', 'Respond with a password to the first prompt',
            { enabled: (c) => !c.site.sshNoUserAuth && c.site.authKI }),
        ],
      },
      {
        id: 'AuthenticationParamsGroup', caption: 'Authentication parameters',
        enabled: (c) => !c.site.sshNoUserAuth,
        controls: [
          filename('PrivateKeyEdit3', 'publicKeyFile', 'Private key file:'),
          button('PrivateKeyToolsButton', 'Tools', (ctx, anchor) => openMenu({
            anchor,
            items: [
              { label: 'Generate New Key Pair with PuTTYgen…', icon: 'key', onSelect: () => ctx.runAction('runPuttygen') },
              { label: 'Install Public Key into Server…', icon: 'upload', onSelect: () => ctx.runAction('installKey') },
            ],
          })),
          button('PrivateKeyViewButton', 'Display Public Key', (ctx) => ctx.runAction('displayPublicKey'),
            { enabled: (c) => !!c.site.publicKeyFile }),
          secret('PrivateKeyPassphraseEdit', 'passphrase', 'Key passphrase:',
            { enabled: (c) => !c.site.sshNoUserAuth && !!c.site.publicKeyFile }),
          filename('DetachedCertificateEdit', 'detachedCertificate', 'Certificate to use with the private key:',
            { enabled: (c) => !c.site.sshNoUserAuth && !!c.site.publicKeyFile }),
          check('AgentFwdCheck', 'agentFwd', 'Allow agent forwarding',
            { enabled: (c) => !c.site.sshNoUserAuth && c.site.tryAgent }),
        ],
      },
      {
        id: 'GSSAPIGroup', caption: 'GSSAPI',
        enabled: (c) => !c.site.sshNoUserAuth,
        controls: [
          check('AuthGSSAPICheck3', 'authGSSAPI', 'Attempt GSSAPI authentication', { gap: 'authGSSAPI' }),
          check('GSSAPIFwdTGTCheck', 'gssapiFwdTGT', 'Allow GSSAPI credential delegation',
            { enabled: (c) => !c.site.sshNoUserAuth && c.site.authGSSAPI, gap: 'gssapiFwdTGT' }),
          orderlist('GssLibListBox', 'gssLibList', 'GSSAPI library order:', GSS_LIBRARIES,
            { gap: 'gssLibList', noWarn: true }),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'bugs', caption: 'Bugs', level: 2, icon: 'error',
    enabled: (c) => c.ssh,
    disabledReason: 'These workarounds apply to SSH sessions only.',
    groups: [
      {
        id: 'BugsGroupBox', caption: 'Detection of known bugs in SSH servers',
        controls: [
          autoswitch('BugHMAC2Combo', 'sshBugs.hmac2', 'Miscomputes SSH MAC keys:'),
          autoswitch('BugDeriveKey2Combo', 'sshBugs.deriveKey2', 'Miscomputes SSH encryption keys:'),
          autoswitch('BugRSAPad2Combo', 'sshBugs.rsaPad2', 'Requires padding on SSH RSA signatures:'),
          autoswitch('BugPKSessID2Combo', 'sshBugs.pkSessID2', 'Misuses the session ID in SSH PK auth:'),
          autoswitch('BugRekey2Combo', 'sshBugs.rekey2', 'Handles SSH key re-exchange badly:'),
          autoswitch('BugMaxPkt2Combo', 'sshBugs.maxPkt2', 'Ignores SSH maximum packet size:'),
          autoswitch('BugIgnore2Combo', 'sshBugs.ignore2', 'Chokes on SSH ignore messages:'),
          autoswitch('BugWinAdjCombo', 'sshBugs.winadj', 'Chokes on the window-adjust request:'),
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'note', caption: 'Note', level: 0, icon: 'description',
    groups: [
      {
        id: 'NoteGroup', caption: 'Note',
        controls: [memo('NoteMemo', 'note', 'Note:',
          { rows: 8, hint: 'Free text shown beside the site in the site list and searched by the "all major site fields" mode.' })],
      },
    ],
  },
];

/* ---- proxy enablement, transcribed from UpdateControls ------------ */

function proxyNeedsHost(c) {
  const m = c.site.proxyMethod;
  if (c.ftp && Number(c.site.ftpProxyLogonType) > 0) return true;
  if (m === 'socks4' || m === 'socks5' || m === 'http' || m === 'telnet') return true;
  return m === 'cmd' && /%proxyhost/i.test(String(c.site.proxyLocalCommand || ''));
}
function proxyNeedsUser(c) {
  const m = c.site.proxyMethod;
  const logon = Number(c.site.ftpProxyLogonType) || 0;
  if (c.ftp && logon > 0 && logon !== 3 && logon !== 5) return true;
  // SOCKS4 carries a user id only on the engines that support it.
  if (m === 'socks4') return c.ssh || c.webdav || c.s3;
  if (m === 'socks5' || m === 'http') return true;
  const command = m === 'cmd' ? c.site.proxyLocalCommand : c.site.proxyTelnetCommand;
  return (m === 'telnet' || m === 'cmd') && /%user/i.test(String(command || ''));
}
function proxyNeedsPassword(c) {
  const m = c.site.proxyMethod;
  const logon = Number(c.site.ftpProxyLogonType) || 0;
  if (c.ftp && logon > 0 && logon !== 3 && logon !== 5) return true;
  if (m === 'socks5' || m === 'http') return true;
  const command = m === 'cmd' ? c.site.proxyLocalCommand : c.site.proxyTelnetCommand;
  return (m === 'telnet' || m === 'cmd') && /%pass/i.test(String(command || ''));
}

/* ================================================================== */
/* value access                                                        */
/* ================================================================== */

function getKey(site, key) {
  if (!key) return undefined;
  return key.split('.').reduce((cur, seg) => (cur == null ? undefined : cur[seg]), site);
}

function setKey(site, key, value) {
  const segs = key.split('.');
  let cur = site;
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
  return site;
}

/**
 * Build the storage-safe patch accepted by the site store.  Keeping this
 * outside the DOM panel makes the persistence boundary explicit and lets
 * non-modal consumers use the same secret handling as the dialog.
 */
export function siteAdvancedPatch(site, touchedSecrets = []) {
  const touched = new Set(touchedSecrets);
  const keep = SECRET_FIELDS.filter((field) => touched.has(field));
  return stripSecrets({ ...site }, { keep });
}

/** Encryption cannot be enabled without a key; a sentinel means one is stored. */
export function encryptionKeyState(site) {
  const enabled = site?.encryptFiles === true;
  const key = site?.encryptKey;
  const available = key === SECRET_SENTINEL || (typeof key === 'string' && key.trim().length > 0);
  return { enabled, available, valid: !enabled || available };
}

/** Normalize the split timezone inputs to the supported inclusive ±24:00 range. */
export function normalizeAdvancedTimezone(hours, minutes) {
  let hh = Math.min(24, Math.max(-24, Math.trunc(Number(hours) || 0)));
  let mm = Math.min(59, Math.max(-59, Math.trunc(Number(minutes) || 0)));
  if (Math.abs(hh) === 24) {
    hh = Math.sign(hh) * 24;
    mm = 0;
  } else if (hh !== 0 && Math.sign(mm) === -Math.sign(hh)) {
    mm = -mm;
  }
  return { hours: hh, minutes: mm, value: hh + mm / 60 };
}

/** Numeric editable combos must not let invalid port values reach the site store. */
export function normalizeAdvancedComboNumber(raw, { min = 0, max = 65535 } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Everything a `visible`/`enabled` predicate is handed. */
export function advancedContext(site, prefs = {}) {
  const info = protocolInfo(site.protocol);
  return {
    site,
    prefs,
    protocol: info.id,
    ssh: info.family === 'ssh',
    sftp: info.id === 'sftp',
    scp: info.id === 'scp',
    ftp: info.id === 'ftp',
    webdav: info.id === 'webdav',
    s3: info.id === 's3',
    neon: info.family === 'neon',
    tls: (info.id === 'ftp' || info.family === 'neon') && site.ftps !== 'none',
  };
}

/** Every control on every page, flattened — the search index's backbone. */
export function allAdvancedControls() {
  const out = [];
  for (const page of SITE_ADVANCED_PAGES) {
    for (const group of page.groups) {
      for (const control of group.controls) out.push({ page, group, control });
    }
  }
  return out;
}

/** A human-readable current value, used by the search and by screen readers. */
export function describeValue(control, site) {
  const raw = getKey(site, control.key);
  if (raw === undefined || raw === null) return '';
  switch (control.kind) {
    case 'check': return raw ? 'on' : 'off';
    case 'checkNumber': return raw ? 'on' : 'off';
    case 'tricheck': return String(raw);
    case 'select': {
      const found = (control.options || []).find(([value]) => String(value) === String(raw));
      return found ? found[1] : String(raw);
    }
    case 'radios': {
      const found = (control.options || []).find(([value]) => value === raw);
      return found ? found[1] : String(raw);
    }
    case 'orderlist': return Array.isArray(raw) ? raw.join(', ') : String(raw);
    case 'memo': return Array.isArray(raw) ? raw.join(' ') : String(raw);
    // A secret's VALUE is never rendered anywhere, including the search index:
    // making a stored password findable by typing it would be a disclosure.
    case 'secret': return raw ? 'stored' : 'not set';
    default: return String(raw);
  }
}

/** The text a control is searched by: label, hint, gap note and value. */
export function searchTextOf(control, site) {
  return [control.label, control.hint, control.gap ? GAPS[control.gap] : '', describeValue(control, site)]
    .filter(Boolean).join(' · ');
}

/**
 * Merge a stored algorithm order with the full catalogue.
 *
 * A site saved before an algorithm existed must not make that algorithm
 * unreachable, so anything missing is added back — on the side of the WARN
 * marker the catalogue puts it. Dropping every newcomer below the line would
 * demote AES-GCM and the post-quantum key exchanges to "no longer considered
 * secure", which is the opposite of true; adding them all above it would
 * silently promote a deprecated one. The catalogue already encodes which is
 * which, so it decides.
 */
export function mergeAlgorithmOrder(stored, catalogue, { noWarn = false } = {}) {
  const known = catalogue.map(([id]) => id);
  const catalogueWarn = known.indexOf('WARN');
  const list = (Array.isArray(stored) ? stored : []).filter((id) => known.includes(id));
  const missing = known.filter((id) => !list.includes(id) && id !== 'WARN');
  if (!noWarn && catalogueWarn >= 0 && !list.includes('WARN')) list.push('WARN');
  if (!missing.length) return list.slice();

  const warnAt = list.indexOf('WARN');
  if (noWarn || warnAt < 0 || catalogueWarn < 0) return [...list, ...missing];

  const above = missing.filter((id) => known.indexOf(id) < catalogueWarn);
  const below = missing.filter((id) => known.indexOf(id) > catalogueWarn);
  return [...list.slice(0, warnAt), ...above, 'WARN', ...list.slice(warnAt + 1), ...below];
}

/* ================================================================== */
/* the panel                                                           */
/* ================================================================== */

/**
 * createSiteAdvancedPanel(site, opts) -> handle
 *
 * `site` is a working copy: the panel mutates it in place and the caller reads
 * `handle.site` when the user accepts. Nothing is written to storage here.
 */
export function createSiteAdvancedPanel(site, opts = {}) {
  installSessionDialogStyles();

  const state = {
    site,
    prefs: opts.prefs || {},
    pageId: opts.pageId || SITE_ADVANCED_PAGES[0].id,
    /** Secrets the user actually retyped, so the sentinel is never written back. */
    touchedSecrets: new Set(),
  };

  const navEl = h('div', { class: 'sa-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('advancedBtn') });
  // One panel serves every tab, so every tab's aria-controls points at it and
  // its aria-labelledby follows the selection. A role="tab" whose aria-controls
  // named a page that is not in the document would be worse than none: a screen
  // reader announces a broken reference instead of the page's name.
  const pageId = uid('sa-panel');
  const tabIds = new Map(SITE_ADVANCED_PAGES.map((p) => [p.id, uid(`sa-tab-${p.id}`)]));
  const pageEl = h('div', { class: 'sa-page', id: pageId, role: 'tabpanel', tabindex: '0' });
  const root = h('div', { class: 'sd-split sd-wide sd-wide-lg', style: { minHeight: 'calc(420px * var(--uiscale))' } }, navEl, pageEl);
  appearanceTarget(navEl, 'site-advanced-nav', 'Advanced settings navigation');
  appearanceTarget(pageEl, 'site-advanced-page', 'Advanced settings page');

  /** One search bar per page, created on first visit and then reused. */
  const searchBars = new Map();

  function ctx() { return advancedContext(state.site, state.prefs); }

  function pageEnabled(page) {
    return typeof page.enabled === 'function' ? !!page.enabled(ctx()) : true;
  }

  /**
   * A button's handler gets the working site AND the helpers below, because a
   * handler that writes a secret has to mark it as touched — otherwise the
   * save path strips it as "unchanged" and the value the user just generated
   * is silently thrown away.
   */
  const actionHelpers = {
    setValue(key, value) { setKey(state.site, key, value); renderPage(); },
    setSecret(key, value) {
      state.touchedSecrets.add(key);
      setKey(state.site, key, value);
      renderPage();
    },
    refresh() { renderNav(); renderPage(); },
  };

  function runAction(id, ...args) {
    if (typeof opts.onAction === 'function') return opts.onAction(id, state.site, actionHelpers, ...args);
    notify.info(t('advancedBtn'), `"${id}" is handled by the login dialog that opened this panel.`);
    return null;
  }

  const actionCtx = { runAction, get site() { return state.site; } };

  /* ---------------- navigation ---------------- */

  function renderNav() {
    clear(navEl);
    for (const page of SITE_ADVANCED_PAGES) {
      const on = page.id === state.pageId;
      const usable = pageEnabled(page);
      const hits = matchCountFor(page);
      const btn = h('button', {
        type: 'button', class: `sa-nav-item${usable ? '' : ' is-off'}`, role: 'tab',
        id: tabIds.get(page.id),
        'aria-controls': pageId,
        'aria-selected': String(on), tabindex: on ? '0' : '-1',
        'data-page': page.id,
        style: { paddingLeft: `calc(${8 + (page.level === 2 ? 18 : 0)}px * var(--den))` },
        title: usable ? page.caption : `${page.caption} — ${page.disabledReason || 'not used by this protocol'}`,
        onclick: () => setPage(page.id),
      },
      icon(page.icon || 'tune', 16),
      h('span', { class: 'sa-nav-label' }, page.caption));
      if (hits) btn.appendChild(h('span', { class: 'sa-nav-count' }, String(hits)));
      appearanceTarget(btn, `site-advanced-nav-${page.id}`, `Advanced page: ${page.caption}`);
      navEl.appendChild(btn);
    }
  }

  navEl.addEventListener('keydown', (e) => {
    const order = SITE_ADVANCED_PAGES.map((p) => p.id);
    const i = order.indexOf(state.pageId);
    if (e.key === 'ArrowDown') { e.preventDefault(); setPage(order[(i + 1) % order.length], true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPage(order[(i - 1 + order.length) % order.length], true); }
    else if (e.key === 'Home') { e.preventDefault(); setPage(order[0], true); }
    else if (e.key === 'End') { e.preventDefault(); setPage(order[order.length - 1], true); }
  });

  function setPage(id, focus = false) {
    if (!SITE_ADVANCED_PAGES.some((p) => p.id === id)) return;
    state.pageId = id;
    renderNav();
    renderPage();
    if (focus) navEl.querySelector(`[data-page="${id}"]`)?.focus();
    announce(SITE_ADVANCED_PAGES.find((p) => p.id === id).caption);
  }

  /* ---------------- search ---------------- */

  function barFor(page) {
    if (searchBars.has(page.id)) return searchBars.get(page.id);
    const bar = createSearchBar({
      id: `site-advanced-${page.id}`,
      compact: true,
      labelKey: 'prefsSearchPh',
      placeholder: `Search ${page.caption}`,
      appearanceKey: `search-site-advanced-${page.id}`,
      appearanceLabel: `Advanced ${page.caption} search`,
      sampleProvider: () => page.groups.flatMap((g) => g.controls.map((c) => searchTextOf(c, state.site))).join('\n'),
      onChange: () => { renderPage(); renderNav(); },
    });
    searchBars.set(page.id, bar);
    return bar;
  }

  /** How many controls on `page` match the ACTIVE page's query. */
  function matchCountFor(page) {
    const active = SITE_ADVANCED_PAGES.find((p) => p.id === state.pageId);
    const bar = searchBars.get(active.id);
    if (!bar || !bar.isActive) return 0;
    const controls = page.groups.flatMap((g) => g.controls);
    return filterBy(controls, bar.predicate, (c) => [searchTextOf(c, state.site)]).length;
  }

  /* ---------------- page rendering ---------------- */

  /**
   * A commit re-renders the whole page, because one setting routinely enables
   * or disables another. That would drop the keyboard user's place: the element
   * they just operated is destroyed and focus falls to <body>, so tabbing
   * restarts from the top of the dialog after every checkbox. These two
   * functions remember where focus was and put it back on the element that
   * replaced it — matched by the control it belongs to and its position within
   * that control, which survives a rebuild in a way an element identity cannot.
   */
  function captureFocus() {
    const active = document.activeElement;
    if (!active || !pageEl.contains(active)) return null;
    // The search bar is the same node every render, so it is restored by
    // identity — and with its caret, or typing a query would jump to the end
    // of the field after each keystroke.
    const caret = 'selectionStart' in active ? active.selectionStart : null;
    const wrap = active.closest('[data-control]');
    if (!wrap) return { node: active, caret };
    const peers = Array.from(wrap.querySelectorAll('input, select, textarea, button'));
    return { control: wrap.getAttribute('data-control'), index: Math.max(0, peers.indexOf(active)), caret };
  }

  function restoreFocus(mark) {
    if (!mark) return;
    let target = null;
    if (mark.node) {
      if (!pageEl.contains(mark.node)) return;
      target = mark.node;
    } else {
      const wrap = pageEl.querySelector(`[data-control="${CSS.escape(mark.control)}"]`);
      if (!wrap) return;
      const peers = Array.from(wrap.querySelectorAll('input, select, textarea, button'))
        .filter((el) => !el.disabled);
      target = peers[mark.index] || peers[0];
    }
    if (!target) return;
    target.focus();
    if (mark.caret !== null && mark.caret !== undefined && 'setSelectionRange' in target) {
      try { target.setSelectionRange(mark.caret, mark.caret); } catch { /* not a text field */ }
    }
  }

  function renderPage() {
    const page = SITE_ADVANCED_PAGES.find((p) => p.id === state.pageId);
    const c = ctx();
    const usable = pageEnabled(page);
    const bar = barFor(page);
    const focusMark = captureFocus();

    pageEl.setAttribute('aria-labelledby', tabIds.get(page.id));
    clear(pageEl);
    pageEl.appendChild(h('div', { class: 'sa-page-head' },
      h('h3', { class: 'sa-page-title' }, page.caption),
      bar.element));

    if (!usable) {
      pageEl.appendChild(h('div', { class: 'sd-note' }, icon('info', 15),
        h('span', {}, `${page.disabledReason || 'This page does not apply to the selected protocol.'} The settings below keep their values and are used again as soon as the protocol changes back.`)));
    }

    let shown = 0;
    for (const group of page.groups) {
      if (group.visible && !group.visible(c)) continue;
      const controls = visibleControls(group, c, bar);
      if (!controls.length) continue;
      const groupEnabled = usable && (!group.enabled || group.enabled(c));
      pageEl.appendChild(buildGroup(group, controls, c, groupEnabled));
      shown += controls.length;
    }

    if (!shown) {
      pageEl.appendChild(h('p', { class: 'st-empty prose' },
        bar.isActive ? noMatchMessage(bar.predicate, `the ${page.caption} page`) : 'This page has no options for the selected protocol.'));
    }

    if (bar.isActive) renderCrossPageHits(page, bar);
    restoreFocus(focusMark);
  }

  function visibleControls(group, c, bar) {
    let controls = group.controls.filter((control) => !control.visible || control.visible(c));
    if (bar.isActive) controls = filterBy(controls, bar.predicate, (control) => [searchTextOf(control, state.site)]);
    return controls;
  }

  function renderCrossPageHits(page, bar) {
    const elsewhere = SITE_ADVANCED_PAGES
      .filter((p) => p.id !== page.id)
      .map((p) => ({ page: p, count: matchCountFor(p) }))
      .filter((entry) => entry.count > 0);
    if (!elsewhere.length) return;

    const total = elsewhere.reduce((sum, e) => sum + e.count, 0);
    const box = h('div', { class: 'sa-hit' },
      h('span', {}, `${total} other ${total === 1 ? 'match is' : 'matches are'} on a different page: `));
    elsewhere.forEach((entry, i) => {
      if (i) box.appendChild(h('span', {}, ', '));
      box.appendChild(h('button', {
        type: 'button',
        onclick: () => {
          // Carry the query across so the destination page opens filtered.
          const next = barFor(entry.page);
          const s = bar.state;
          if (s.mode === 'regex') next.setPattern(s.pattern, s.flags);
          else next.setQuery(s.query);
          setPage(entry.page.id, true);
        },
      }, `${entry.page.caption} (${entry.count})`));
    });
    pageEl.appendChild(box);
  }

  function buildGroup(group, controls, c, groupEnabled) {
    const box = h('fieldset', { class: `sd-group${groupEnabled ? '' : ' is-disabled'}` });
    if (group.caption) box.appendChild(h('legend', {}, group.caption));
    if (group.gap && GAPS[group.gap]) box.appendChild(gapNote(GAPS[group.gap]));
    for (const control of controls) {
      const node = buildControl(control, c, groupEnabled);
      if (node) box.appendChild(node);
    }
    appearanceTarget(box, `site-advanced-group-${group.id}`, `Advanced group: ${group.caption || group.id}`);
    return box;
  }

  function gapNote(message) {
    return h('div', { class: 'sd-note' }, icon('info', 15), h('span', {}, message));
  }

  /* ---------------- individual controls ---------------- */

  function buildControl(control, c, groupEnabled) {
    const enabled = groupEnabled && (!control.enabled || control.enabled(c));
    const id = uid(`sa-${control.id}`);
    const wrap = h('div', { class: 'sd-control', 'data-control': control.id });

    const commit = (value) => {
      setKey(state.site, control.key, value);
      opts.onChange?.(state.site, control);
      // A change can enable or disable other controls, so the page re-renders.
      renderPage();
    };

    let body = null;
    switch (control.kind) {
      case 'check': body = buildCheck(control, id, enabled, commit); break;
      case 'checkNumber': body = buildCheckNumber(control, id, enabled, commit); break;
      case 'tricheck': body = buildTriCheck(control, id, enabled, commit); break;
      case 'text': body = buildText(control, id, enabled, commit, 'text'); break;
      case 'secret': body = buildSecret(control, id, enabled); break;
      case 'number': body = buildNumber(control, id, enabled, commit); break;
      case 'select': body = buildSelect(control, id, enabled, commit); break;
      case 'combo': body = buildCombo(control, id, enabled, commit); break;
      case 'memo': body = buildMemo(control, id, enabled, commit); break;
      case 'radios': body = buildRadios(control, id, enabled, commit, c); break;
      case 'filename': body = buildPath(control, id, enabled, commit, 'file'); break;
      case 'directory': body = buildPath(control, id, enabled, commit, 'directory'); break;
      case 'orderlist': body = buildOrderList(control, id, enabled, commit); break;
      case 'timezone': body = buildTimezone(control, id, enabled, commit); break;
      case 'proxymethod': body = buildProxyMethod(control, id, enabled, commit, c); break;
      case 'static': body = h('p', { class: 'sd-hint prose' }, control.label); break;
      case 'button': body = buildButton(control, enabled); break;
      default: body = null;
    }
    if (!body) return null;
    wrap.appendChild(body);

    if (control.hint && control.kind !== 'static') {
      wrap.appendChild(h('p', { class: 'sd-hint prose' }, control.hint));
    }
    if (control.gap && GAPS[control.gap]) wrap.appendChild(gapNote(GAPS[control.gap]));
    if (control.id === 'EncryptFilesCheck' && encryptionKeyState(state.site).enabled && !encryptionKeyState(state.site).available) {
      wrap.appendChild(h('p', { class: 'sd-hint sd-full', role: 'alert' },
        'Encryption is enabled but no encryption key is set. Add a key before saving this site.'));
    }
    if (control.id === 'EncryptKeyEdit' && encryptionKeyState(state.site).enabled && !encryptionKeyState(state.site).available) {
      wrap.appendChild(h('p', { class: 'sd-hint sd-full', role: 'alert' },
        'Required while file encryption is enabled. The key is stored as a protected secret.'));
    }
    appearanceTarget(wrap, `site-advanced-${control.id}`, control.label || control.id);
    return wrap;
  }

  function labelled(control, id, node, enabled) {
    return h('div', { class: 'sd-grid' },
      h('label', { class: `sd-label${enabled ? '' : ' is-disabled'}`, for: id }, control.label),
      node);
  }

  function buildCheck(control, id, enabled, commit) {
    const input = h('input', { type: 'checkbox', id, onchange: () => commit(input.checked) });
    input.checked = !!getKey(state.site, control.key);
    input.disabled = !enabled;
    const label = h('label', { class: `sd-check${enabled ? '' : ' is-disabled'}`, for: id },
      input, h('span', { class: 'sd-check-text' }, control.label));
    if (control.warning && input.checked) {
      label.appendChild(h('span', { class: 'sd-hint sd-full', role: 'alert' }, control.warning));
    }
    return label;
  }

  /** BufferSizeCheck: a check box whose two states are two numeric values. */
  function buildCheckNumber(control, id, enabled, commit) {
    const input = h('input', {
      type: 'checkbox', id,
      onchange: () => commit(input.checked ? control.onValue : control.offValue),
    });
    input.checked = Number(getKey(state.site, control.key)) !== control.offValue;
    input.disabled = !enabled;
    return h('label', { class: `sd-check${enabled ? '' : ' is-disabled'}`, for: id },
      input, h('span', { class: 'sd-check-text' }, control.label,
        h('span', { class: 'sd-hint', style: { display: 'block' } },
          `On sets the socket buffer to ${control.onValue.toLocaleString()} bytes; off lets the operating system choose.`)));
  }

  /**
   * CheckBoxAutoSwitchLoad: a three-state check box. Indeterminate is "auto",
   * which is a real setting here rather than an unset one, so it is announced.
   */
  function buildTriCheck(control, id, enabled, commit) {
    const order = ['auto', 'on', 'off'];
    const value = String(getKey(state.site, control.key) || 'auto');
    const input = h('input', {
      type: 'checkbox', id,
      'aria-checked': value === 'auto' ? 'mixed' : String(value === 'on'),
      onclick: (e) => {
        e.preventDefault();
        const next = order[(order.indexOf(value) + 1) % order.length];
        commit(next);
        announce(`${control.label}: ${next}`);
      },
    });
    input.checked = value === 'on';
    input.indeterminate = value === 'auto';
    input.disabled = !enabled;
    return h('label', { class: `sd-check${enabled ? '' : ' is-disabled'}`, for: id },
      input, h('span', { class: 'sd-check-text' }, control.label,
        h('span', { class: 'sd-hint', style: { display: 'block' } }, `Currently: ${value}`)));
  }

  function buildText(control, id, enabled, commit, type) {
    const input = h('input', {
      type, id, class: 'sd-input', spellcheck: 'false', autocomplete: 'off',
      placeholder: control.placeholder || '',
      oninput: () => setKey(state.site, control.key, input.value),
      onchange: () => commit(input.value),
    });
    input.value = String(getKey(state.site, control.key) ?? '');
    input.disabled = !enabled;
    return labelled(control, id, input, enabled);
  }

  /**
   * A stored secret never comes back from main — config:sites replaces it with
   * a sentinel. The field therefore shows empty with "unchanged" beside it, and
   * only a value the user actually types is ever written back.
   */
  function buildSecret(control, id, enabled) {
    const stored = getKey(state.site, control.key);
    const isStored = stored === SECRET_SENTINEL;
    const input = h(control.multiline ? 'textarea' : 'input', {
      id, class: 'sd-input', spellcheck: 'false', autocomplete: 'new-password',
      rows: control.multiline ? 3 : undefined,
      placeholder: isStored ? '(unchanged — type to replace)' : '',
      oninput: () => {
        state.touchedSecrets.add(control.key);
        setKey(state.site, control.key, input.value);
      },
    });
    if (!control.multiline) input.type = 'password';
    input.value = state.touchedSecrets.has(control.key) ? String(stored ?? '') : '';
    input.disabled = !enabled;

    const revealBtn = h('button', {
      type: 'button', class: 'icon-btn', 'aria-pressed': 'false',
      'aria-label': 'Show the value', title: 'Show the value',
      onclick: () => {
        const on = revealBtn.getAttribute('aria-pressed') === 'true';
        revealBtn.setAttribute('aria-pressed', String(!on));
        if (!control.multiline) input.type = on ? 'password' : 'text';
        else input.classList.toggle('is-revealed', !on);
      },
    }, icon('visibility', 16));
    revealBtn.disabled = !enabled || control.multiline;

    const clearBtn = h('button', {
      type: 'button', class: 'btn-text',
      onclick: () => {
        state.touchedSecrets.add(control.key);
        input.value = '';
        setKey(state.site, control.key, '');
        renderPage();
      },
    }, 'Clear');
    clearBtn.disabled = !enabled;

    const row = h('div', { class: 'lg-secret' }, input, control.multiline ? null : revealBtn, clearBtn);
    const node = labelled(control, id, row, enabled);
    if (isStored && !state.touchedSecrets.has(control.key)) {
      node.appendChild(h('span', { class: 'sd-hint sd-full' },
        'A value is stored. It is never sent back to this window; leave the box empty to keep it.'));
    }
    return node;
  }

  function buildNumber(control, id, enabled, commit) {
    const input = h('input', {
      type: 'number', id, class: 'sd-input sd-num',
      min: String(control.min ?? 0), max: String(control.max ?? 99999),
      oninput: () => setKey(state.site, control.key, clampNumber(control, input.value)),
      onchange: () => { input.value = String(clampNumber(control, input.value)); commit(Number(input.value)); },
    });
    input.value = String(Number(getKey(state.site, control.key) ?? 0));
    input.disabled = !enabled;
    const step = (delta) => {
      input.value = String(clampNumber(control, Number(input.value) + delta));
      commit(Number(input.value));
    };
    const stepper = h('div', { class: 'sd-stepper' },
      h('button', { type: 'button', 'aria-label': `Increase ${control.label}`, onclick: () => step(1) }, icon('expand_less', 13)),
      h('button', { type: 'button', 'aria-label': `Decrease ${control.label}`, onclick: () => step(-1) }, icon('expand_more', 13)));
    for (const b of stepper.querySelectorAll('button')) b.disabled = !enabled;
    const row = h('div', { class: 'sd-row is-tight' }, input, stepper,
      control.unit ? h('span', { class: 'sd-hint' }, control.unit) : null);
    return labelled(control, id, row, enabled);
  }

  function clampNumber(control, raw) {
    const n = Number.parseInt(raw, 10);
    const min = control.min ?? 0;
    const max = control.max ?? 99999;
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function buildSelect(control, id, enabled, commit) {
    const select = h('select', {
      id, class: 'sd-input',
      onchange: () => commit(control.numeric && select.value !== 'auto' ? Number(select.value) : select.value),
    }, ...control.options.map(([value, label]) => h('option', { value: String(value) }, label)));
    select.value = String(getKey(state.site, control.key) ?? control.options[0][0]);
    select.disabled = !enabled;
    return labelled(control, id, select, enabled);
  }

  /** An editable combo: a text field with a datalist of the .dfm's items. */
  function buildCombo(control, id, enabled, commit) {
    const listId = uid('sa-list');
    const input = h('input', {
      type: 'text', id, class: 'sd-input', list: listId, spellcheck: 'false',
      autocomplete: 'off', placeholder: control.placeholder || '',
      oninput: () => setKey(state.site, control.key, control.numeric ? normalizeAdvancedComboNumber(input.value) : input.value),
      onchange: () => commit(control.numeric ? normalizeAdvancedComboNumber(input.value) : input.value),
    });
    input.value = String(getKey(state.site, control.key) ?? '');
    input.disabled = !enabled;
    const datalist = h('datalist', { id: listId },
      ...control.suggestions.filter(Boolean).map((s) => h('option', { value: String(s) })));
    return labelled(control, id, h('div', { class: 'sd-row is-tight' }, input, datalist), enabled);
  }

  function buildMemo(control, id, enabled, commit) {
    const stored = getKey(state.site, control.key);
    const area = h('textarea', {
      id, class: 'sd-input', rows: String(control.rows || 4), spellcheck: 'false',
      oninput: () => setKey(state.site, control.key, control.lines ? area.value.split('\n').filter((l) => l.trim()) : area.value),
      onchange: () => commit(control.lines ? area.value.split('\n').filter((l) => l.trim()) : area.value),
    });
    area.value = Array.isArray(stored) ? stored.join('\n') : String(stored ?? '');
    area.disabled = !enabled;
    return labelled(control, id, area, enabled);
  }

  function buildRadios(control, id, enabled, commit, c) {
    const name = uid('sa-radio');
    const current = getKey(state.site, control.key);
    const group = h('div', {
      class: 'sd-radios', role: 'radiogroup', 'aria-label': control.label, id,
    });
    for (const [value, label] of control.options) {
      const rid = uid('sa-r');
      const optionOn = !control.optionEnabled || control.optionEnabled(value, c);
      const input = h('input', { type: 'radio', name, id: rid, value: String(value), onchange: () => commit(value) });
      input.checked = current === value;
      input.disabled = !enabled || !optionOn;
      group.appendChild(h('label', { class: `sd-check${enabled && optionOn ? '' : ' is-disabled'}`, for: rid },
        input, h('span', { class: 'sd-check-text' }, label)));
    }
    return h('div', { class: 'sd-grid' },
      h('span', { class: `sd-label${enabled ? '' : ' is-disabled'}` }, control.label),
      group);
  }

  function buildPath(control, id, enabled, commit, mode) {
    const input = h('input', {
      type: 'text', id, class: 'sd-input', spellcheck: 'false', autocomplete: 'off',
      oninput: () => setKey(state.site, control.key, input.value),
      onchange: () => commit(input.value),
    });
    input.value = String(getKey(state.site, control.key) ?? '');
    input.disabled = !enabled;
    const browse = h('button', {
      type: 'button', class: 'btn-tonal',
      onclick: async () => {
        try {
          const picker = api.raw?.app?.pickPath;
          if (!picker) {
            notify.info(t('browse'), 'The file picker needs the application shell. Type the path instead.');
            return;
          }
          // app:pickPath takes { directory, multiple, save, title, … } and
          // resolves to an array of paths or null.
          const res = await picker({ directory: mode === 'directory', title: control.label });
          const value = res?.ok && Array.isArray(res.value) ? res.value[0] : null;
          if (value) { input.value = value; commit(value); }
        } catch (err) { notify.error(t('browse'), err.message || String(err)); }
      },
    }, icon(mode === 'directory' ? 'folder_open' : 'description', 15), h('span', {}, t('browse')));
    browse.disabled = !enabled;
    return labelled(control, id, h('div', { class: 'sd-row is-tight' }, input, browse), enabled);
  }

  /**
   * TimeDifferenceEdit + TimeDifferenceMinutesEdit as one fractional-hours key.
   *
   * BOTH boxes carry the sign, exactly as SiteAdvanced.cpp splits the stored
   * value (`TimeDifferenceMin / 60` and `TimeDifferenceMin % 60`, which in C++
   * and in JavaScript alike keep the sign of the dividend). Forcing minutes
   * positive and taking the sign from hours alone loses it entirely for an
   * offset inside the first hour: −30 minutes would be shown as 0h 30m and
   * written back as +30, silently flipping a clock correction.
   */
  function buildTimezone(control, id, enabled, commit) {
    const totalMinutes = Math.round(Number(getKey(state.site, control.key) || 0) * 60);
    const hours = Math.trunc(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    const hoursInput = h('input', {
      type: 'number', id, class: 'sd-input sd-num', min: '-24', max: '24',
      'aria-label': `${control.label} hours`,
      onchange: () => write(),
    });
    hoursInput.value = String(hours);
    const minutesInput = h('input', {
      type: 'number', class: 'sd-input sd-num', min: '-59', max: '59',
      'aria-label': `${control.label} minutes`,
      onchange: () => write(),
    });
    minutesInput.value = String(minutes);
    hoursInput.disabled = !enabled;
    minutesInput.disabled = !enabled;

    function write() {
      const normalized = normalizeAdvancedTimezone(hoursInput.value, minutesInput.value);
      hoursInput.value = String(normalized.hours);
      minutesInput.value = String(normalized.minutes);
      commit(normalized.value);
    }

    return labelled(control, id, h('div', { class: 'sd-row is-tight' },
      hoursInput, h('span', { class: 'sd-hint' }, 'hours'),
      minutesInput, h('span', { class: 'sd-hint' }, 'minutes')), enabled);
  }

  /**
   * One proxy combo per engine, exactly as the original keeps three and shows
   * whichever matches the protocol. The value is shared, so switching protocol
   * never loses the choice — it is only re-expressed in the other engine's
   * vocabulary.
   */
  function buildProxyMethod(control, id, enabled, commit, c) {
    const options = c.ssh ? SSH_PROXY_METHODS : c.ftp ? SSH_PROXY_METHODS.slice(0, 4) : NEON_PROXY_METHODS;
    const select = h('select', { id, class: 'sd-input', onchange: () => commit(select.value) },
      ...options.map(([value, label]) => h('option', { value }, label)));
    const current = String(getKey(state.site, control.key) || 'none');
    select.value = options.some(([value]) => value === current) ? current : 'none';
    select.disabled = !enabled;

    const node = labelled(control, id, select, enabled);
    if (current !== select.value) {
      node.appendChild(h('span', { class: 'sd-hint sd-full' },
        `This site is stored with proxy type "${current}", which the ${c.protocol.toUpperCase()} engine cannot use. The stored value is kept; choosing another here replaces it.`));
    }
    return node;
  }

  /**
   * The algorithm preference lists. Reordering is what these are for, so the
   * list is a real listbox: one tab stop, arrow keys to move the selection,
   * Alt+Arrow (and the two buttons) to move the item.
   */
  function buildOrderList(control, id, enabled, commit) {
    const merged = mergeAlgorithmOrder(getKey(state.site, control.key), control.catalogue, { noWarn: control.noWarn });
    const labels = new Map(control.catalogue);
    const warnAt = merged.indexOf('WARN');
    let selected = 0;

    const list = h('div', {
      class: 'sa-orderlist', role: 'listbox', id,
      'aria-label': control.label, tabindex: '0',
    });

    function paint() {
      clear(list);
      merged.forEach((algorithm, index) => {
        const isWarn = algorithm === 'WARN';
        const below = warnAt >= 0 && index > warnAt;
        const unsupported = (control.unsupported || []).includes(algorithm);
        const item = h('div', {
          id: orderListOptionId(id, index),
          class: `sa-orderitem${isWarn ? ' is-warn' : ''}${below ? ' is-below' : ''}${unsupported ? ' is-gap' : ''}`,
          role: 'option', 'aria-selected': String(index === selected),
          'data-index': String(index),
          title: unsupported ? 'This algorithm is not offered by this port’s SSH engine. Its position is stored and the session log says it was not offered.' : '',
          onclick: () => { selected = index; paint(); },
        }, h('span', { class: 'ellipsis' }, labels.get(algorithm) || algorithm));
        if (unsupported) item.appendChild(icon('warning', 13));
        list.appendChild(item);
      });
      upBtn.disabled = !enabled || selected <= 0;
      downBtn.disabled = !enabled || selected >= merged.length - 1;
      const active = list.querySelector('[aria-selected="true"]');
      if (active) list.setAttribute('aria-activedescendant', active.id || '');
    }

    function move(delta) {
      const target = selected + delta;
      if (target < 0 || target >= merged.length) return;
      const [item] = merged.splice(selected, 1);
      merged.splice(target, 0, item);
      selected = target;
      commitOrder();
      announce(`${labels.get(item) || item} moved to position ${target + 1} of ${merged.length}`);
    }

    function commitOrder() {
      setKey(state.site, control.key, merged.slice());
      opts.onChange?.(state.site, control);
      paint();
    }

    list.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (e.altKey) move(1); else { selected = Math.min(merged.length - 1, selected + 1); paint(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (e.altKey) move(-1); else { selected = Math.max(0, selected - 1); paint(); } }
      else if (e.key === 'Home') { e.preventDefault(); selected = 0; paint(); }
      else if (e.key === 'End') { e.preventDefault(); selected = merged.length - 1; paint(); }
    });

    const upBtn = h('button', { type: 'button', class: 'btn-tonal', onclick: () => move(-1) },
      icon('arrow_upward', 15), h('span', {}, t('up')));
    const downBtn = h('button', { type: 'button', class: 'btn-tonal', onclick: () => move(1) },
      icon('arrow_downward', 15), h('span', {}, t('down')));

    paint();
    if (!enabled) list.setAttribute('aria-disabled', 'true');

    const wrap = h('div', {},
      h('span', { class: `sd-label${enabled ? '' : ' is-disabled'}`, id: `${id}-label` }, control.label),
      h('div', { class: 'sa-order' }, list,
        h('div', { class: 'sa-orderbtns' }, upBtn, downBtn)),
      warnAt >= 0 && !control.noWarn
        ? h('p', { class: 'sd-hint' }, 'Anything below the warning line is offered only after a confirmation, because it is no longer considered secure.')
        : null,
      h('p', { class: 'sd-hint' }, 'Alt+Up and Alt+Down move the selected entry; Up and Down move the selection.'));
    list.setAttribute('aria-labelledby', `${id}-label`);
    return wrap;
  }

  function buildButton(control, enabled) {
    const btn = h('button', { type: 'button', class: 'btn-tonal', onclick: () => control.onSelect(actionCtx, btn) },
      h('span', {}, control.label));
    btn.disabled = !enabled;
    return h('div', { class: 'sd-btnrow' }, btn);
  }

  /* ---------------- public surface ---------------- */

  renderNav();
  renderPage();

  return {
    element: root,
    get site() { return state.site; },
    get touchedSecrets() { return new Set(state.touchedSecrets); },
    validationErrors() {
      return encryptionKeyState(state.site).valid ? [] : ['File encryption requires an encryption key.'];
    },
    /** The patch to send to main: secrets the user never touched are removed. */
    patch() {
      return siteAdvancedPatch(state.site, state.touchedSecrets);
    },
    setPage,
    refresh() { renderNav(); renderPage(); },
    destroy() {
      for (const bar of searchBars.values()) bar.destroy();
      searchBars.clear();
      root.remove();
    },
  };
}

let installed = false;

/** Deferred for the same import-cycle reason as every other dialog here. */
export function registerSiteAdvancedDialog() {
  if (installed) return;
  installed = true;
  registerDialog('siteAdvanced', ({ props }) => {
    const working = structuredCloneish({ ...SESSION_DEFAULTS, ...(props.site || {}) });
    const panel = createSiteAdvancedPanel(working, {
      prefs: props.prefs,
      pageId: props.pageId,
      onAction: props.onAction,
    });
    return {
      title: `${t('advancedBtn')}${props.site?.name ? ` — ${props.site.name}` : ''}`,
      width: 960,
      content: panel.element,
      onClose: () => panel.destroy(),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('ok'), kind: 'filled', autofocus: true,
          onSelect: () => {
            const errors = panel.validationErrors();
            if (errors.length) { notify.error('Cannot save site', errors[0]); return; }
            props.onAccept?.(panel.patch(), panel.touchedSecrets);
          },
        },
      ],
    };
  });
}

function structuredCloneish(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

export function openSiteAdvanced(props = {}) {
  registerSiteAdvancedDialog();
  return openDialog('siteAdvanced', props);
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { registerSiteAdvancedDialog(); } catch (err) { console.error('[siteAdvanced] registration failed', err); }
  });
}

export { GAPS as PROTOCOL_GAP_NOTES, getKey as getSiteKey, setKey as setSiteKey };
export { bindText };

/** Stable DOM id used by the order-list listbox's active-descendant link. */
export function orderListOptionId(listId, index) {
  return `${listId}-option-${index}`;
}
