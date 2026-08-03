// ui/dialogs/generateurl.js — Generate session URL / code (GenerateUrl.dfm).
//
// Three tabs, exactly as the original: a session URL with seven independent
// inclusion switches, a scripting snippet in four formats, and a .NET assembly
// snippet in three languages. Everything is generated locally from the site
// data; nothing is fetched and nothing is sent anywhere.
//
// PASSWORDS. The URL tab can include one because a URL is a thing the user
// pastes into their own address bar and WinSCP does the same. The .NET tab
// NEVER does: generated code gets committed to repositories, and a literal
// secret in a snippet is a leak with a very long half-life. When a password is
// stored, the snippet emits a `null` with a "supply at run time" comment and
// the dialog says so beside the box, rather than silently omitting it.
//
// The top half of this file is pure and DOM-free so test/sitedata.test.js can
// exercise the URL round-trip, the parser and both code generators headlessly.
//
// Reference: vendor/winscp/source/forms/GenerateUrl.{dfm,cpp} and
// vendor/winscp/source/core/SessionData.cpp (ParseUrl / GenerateSessionUrl /
// GenerateAssemblyCode).

import { h, icon, clear, uid, appearanceTarget, copyText, announce } from '../../dom.js';
import { t, bindText } from '../../i18n.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import {
  protocolInfo, defaultPortFor, schemeFor, isDefaultPort,
  installSessionDialogStyles, SECRET_SENTINEL, siteLabel,
} from './sitetree.js';

/* ================================================================== */
/* URL generation                                                      */
/* ================================================================== */

/** core/SessionData.cpp: UrlParamSeparator / UrlParamValueSeparator. */
const PARAM_SEP = ';';
const PARAM_VALUE_SEP = '=';
const HOSTKEY_PARAM = 'fingerprint';
const RAW_PREFIX = 'x-';
const SAVE_PARAM = 'save';
const WINSCP_PREFIX = 'winscp-';

/** The seven UrlSheet check boxes, in the order the .dfm lists them. */
export const URL_FLAGS = Object.freeze([
  { id: 'userName', label: 'User name', hint: 'Include the user name in the URL.' },
  { id: 'password', label: 'Password', secret: true, hint: 'Include the stored password. Anyone who can read the URL can read the password.' },
  { id: 'hostKey', label: 'SSH host key', hint: 'Pin the server\u2019s host key fingerprint so the URL cannot be redirected to another server.' },
  { id: 'winscpSpecific', label: 'WinSCP-specific', hint: 'Prefix the scheme with "winscp-" so the URL opens in this application rather than another handler.' },
  { id: 'remoteDirectory', label: 'Initial directory', hint: 'Include the site\u2019s remote directory as the URL path.' },
  { id: 'saveExtension', label: 'Save extension', hint: 'Append ";save" so opening the URL stores the site instead of connecting.' },
  { id: 'rawSettings', label: 'Advanced settings', hint: 'Include the advanced settings that differ from the defaults as "x-" parameters.' },
]);

export const DEFAULT_URL_FLAGS = Object.freeze({
  userName: true, password: false, hostKey: false, winscpSpecific: false,
  remoteDirectory: false, saveExtension: false, rawSettings: false,
});

/** RFC 3986 unreserved set plus the sub-delims WinSCP leaves alone in a path. */
function encodeUrlPart(value) {
  return encodeURIComponent(String(value ?? ''))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Which advanced settings are worth naming in a URL: only the ones that
 * actually differ from what the protocol would do anyway. A URL carrying the
 * whole option set would be unusable, and one carrying none would silently
 * connect differently from the site it came from.
 */
export function rawSettingsFor(site = {}) {
  const out = {};
  if (site.ftps && site.ftps !== 'none' && site.protocol === 'ftp') out.Ftps = site.ftps;
  if (site.protocol === 'ftp' && site.ftpPasvMode === false) out.FtpPasvMode = 0;
  if (site.compression) out.Compression = 1;
  if (site.publicKeyFile) out.PublicKeyFile = site.publicKeyFile;
  if (site.s3DefaultRegion) out.S3DefaultRegion = site.s3DefaultRegion;
  if (site.s3UrlStyle && site.s3UrlStyle !== 'virtualhost') out.S3UrlStyle = site.s3UrlStyle;
  if (site.timeout && Number(site.timeout) !== 15) out.Timeout = Number(site.timeout);
  if (site.tunnel) {
    out.Tunnel = 1;
    if (site.tunnelHostName) out.TunnelHostName = site.tunnelHostName;
    if (site.tunnelPortNumber && Number(site.tunnelPortNumber) !== 22) out.TunnelPortNumber = Number(site.tunnelPortNumber);
    if (site.tunnelUserName) out.TunnelUserName = site.tunnelUserName;
  }
  if (site.proxyMethod && site.proxyMethod !== 'none') {
    out.ProxyMethod = site.proxyMethod;
    if (site.proxyHost) out.ProxyHost = site.proxyHost;
    if (site.proxyPort) out.ProxyPort = Number(site.proxyPort);
  }
  if (site.protocol === 'sftp' && site.allowScpFallback === false) out.FSProtocol = 'sftponly';
  return out;
}

/**
 * buildSessionUrl(site, flags) -> string
 *
 * Mirrors TSessionData::GenerateSessionUrl. The port number is written only
 * when it is not the protocol's own default, so two sites that connect the
 * same way produce the same URL.
 */
export function buildSessionUrl(site = {}, flags = {}) {
  const f = { ...DEFAULT_URL_FLAGS, ...flags };
  const info = protocolInfo(site.protocol);
  const scheme = schemeFor(info.id, site.ftps);

  let url = f.winscpSpecific ? WINSCP_PREFIX : '';
  url += `${scheme}://`;

  const hasSecret = !!site.password && site.password !== SECRET_SENTINEL;
  if (f.userName && site.userName) {
    url += encodeUrlPart(site.userName);
    if (f.password && hasSecret) url += `:${encodeUrlPart(site.password)}`;
    if (f.hostKey && site.hostKey) {
      url += `${PARAM_SEP}${HOSTKEY_PARAM}${PARAM_VALUE_SEP}${encodeUrlPart(site.hostKey)}`;
    }
    if (f.rawSettings) {
      for (const [k, v] of Object.entries(rawSettingsFor(site))) {
        url += `${PARAM_SEP}${RAW_PREFIX}${encodeUrlPart(k.toLowerCase())}${PARAM_VALUE_SEP}${encodeUrlPart(String(v))}`;
      }
    }
    url += '@';
  }

  const host = String(site.hostName || '');
  // A bare IPv6 literal has to be bracketed or the colon reads as a port.
  // RFC 6874 requires the zone separator in a scoped IPv6 URI literal to be
  // percent-encoded (`%25`) so URL consumers do not treat it as a bad escape.
  url += host.includes(':') ? `[${host.replace(/%/g, '%25')}]` : encodeUrlPart(host);
  if (!isDefaultPort(site)) url += `:${Number(site.portNumber)}`;
  url += '/';

  const dir = String(f.remoteDirectory ? (site.remoteDirectory || '') : '');
  if (dir && dir !== '/') {
    url += dir.replace(/^\/+/, '').split('/').filter(Boolean).map(encodeUrlPart).join('/');
    if (dir.endsWith('/')) url += '/';
  }
  if (f.saveExtension) url += `${PARAM_SEP}${SAVE_PARAM}`;
  return url;
}

/** True when the URL these flags produce would contain a real secret. */
export function urlIncludesSecret(site = {}, flags = {}) {
  const f = { ...DEFAULT_URL_FLAGS, ...flags };
  return !!(f.userName && f.password && site.password && site.password !== SECRET_SENTINEL);
}

/* ------------------------------------------------------------------ */
/* URL parsing                                                         */
/* ------------------------------------------------------------------ */

/** scheme -> { protocol, ftps, port } (ParseUrl's ladder, in the same order). */
const SCHEMES = [
  ['scp', { protocol: 'scp', ftps: 'none', port: 22 }],
  ['sftp', { protocol: 'sftp', ftps: 'none', port: 22 }],
  ['ssh', { protocol: 'sftp', ftps: 'none', port: 22 }],
  ['ftpes', { protocol: 'ftp', ftps: 'explicitTls', port: 21 }],
  ['ftps', { protocol: 'ftp', ftps: 'implicit', port: 990 }],
  ['ftp', { protocol: 'ftp', ftps: 'none', port: 21 }],
  ['davs', { protocol: 'webdav', ftps: 'implicit', port: 443 }],
  ['dav', { protocol: 'webdav', ftps: 'none', port: 80 }],
  ['s3plain', { protocol: 's3', ftps: 'none', port: 80 }],
  ['s3', { protocol: 's3', ftps: 'implicit', port: 443 }],
  ['https', { protocol: 'webdav', ftps: 'implicit', port: 443, s3able: true }],
  ['http', { protocol: 'webdav', ftps: 'none', port: 80, s3able: true }],
];

/**
 * Host suffixes that make an http(s) URL an S3 endpoint rather than a WebDAV
 * one — the same list ParseUrl checks.
 */
const S3_HOSTS = [
  'amazonaws.com', 'digitaloceanspaces.com', 'storage.googleapis.com',
  'r2.cloudflarestorage.com',
];

function isS3Host(host) {
  const h = String(host || '').toLowerCase();
  if (S3_HOSTS.some((s) => h === s || h.endsWith(`.${s}`))) return true;
  return h.endsWith('oraclecloud.com') && h.includes('.compat.objectstorage.');
}

function decodeUrlPart(value) {
  try { return decodeURIComponent(String(value ?? '')); } catch { return String(value ?? ''); }
}

/**
 * parseSessionUrl(url) -> { ok, error, ...siteFields }
 *
 * Accepts everything WinSCP's Login dialog accepts from "Paste Session URL":
 * an optional winscp- prefix, every scheme above, an IPv6 literal in brackets,
 * `user:password@`, `;fingerprint=`, `;x-setting=` raw settings, a path, and a
 * trailing `;save`. A URL with no scheme is read as a bare host, which is what
 * makes pasting `example.com` work.
 */
export function parseSessionUrl(input) {
  const original = String(input ?? '').trim();
  if (!original) return { ok: false, error: 'The URL is empty.' };

  let rest = original;
  let winscpSpecific = false;
  if (/^winscp-/i.test(rest)) { winscpSpecific = true; rest = rest.slice(WINSCP_PREFIX.length); }

  let matched = null;
  for (const [scheme, spec] of SCHEMES) {
    const prefix = `${scheme}:`;
    if (rest.slice(0, prefix.length).toLowerCase() === prefix) {
      matched = { scheme, ...spec };
      rest = rest.slice(prefix.length);
      if (rest.startsWith('//')) rest = rest.slice(2);
      break;
    }
  }
  if (!matched && /^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    return { ok: false, error: `"${rest.split(':')[0]}" is not a file-transfer protocol this application understands.` };
  }

  const out = {
    ok: true,
    error: null,
    protocolDefined: !!matched,
    winscpSpecific,
    protocol: matched ? matched.protocol : 'sftp',
    ftps: matched ? matched.ftps : 'none',
    hostName: '',
    portNumber: matched ? matched.port : 22,
    portDefined: false,
    userName: '',
    password: '',
    hasPassword: false,
    hostKey: '',
    rawSettings: {},
    remoteDirectory: '',
    saveOnly: false,
  };

  // Split the path off first; everything before the first '/' is connect info.
  const slash = rest.indexOf('/');
  const connectInfo = slash < 0 ? rest : rest.slice(0, slash);
  const pathPart = slash < 0 ? '' : rest.slice(slash);

  // The LAST '@' separates user info from host info, so a password containing
  // '@' still parses the way it does in the original.
  const at = connectInfo.lastIndexOf('@');
  const userInfo = at >= 0 ? connectInfo.slice(0, at) : '';
  let hostInfo = at >= 0 ? connectInfo.slice(at + 1) : connectInfo;

  if (hostInfo.startsWith('[')) {
    const close = hostInfo.indexOf(']');
    if (close < 0) return { ok: false, error: 'The IPv6 address in the URL is missing its closing bracket.' };
    out.hostName = decodeUrlPart(hostInfo.slice(1, close));
    hostInfo = hostInfo.slice(close + 1).replace(/^:/, '');
  } else {
    const colon = hostInfo.indexOf(':');
    out.hostName = decodeUrlPart(colon < 0 ? hostInfo : hostInfo.slice(0, colon));
    hostInfo = colon < 0 ? '' : hostInfo.slice(colon + 1);
  }

  if (hostInfo) {
    const port = Number.parseInt(decodeUrlPart(hostInfo), 10);
    if (Number.isFinite(port) && port > 0 && port <= 65535) { out.portNumber = port; out.portDefined = true; }
    else return { ok: false, error: `"${hostInfo}" is not a valid port number.` };
  } else if (matched && matched.s3able && isS3Host(out.hostName)) {
    out.protocol = 's3';
    out.ftps = matched.scheme === 'https' ? 'implicit' : 'none';
    out.portNumber = matched.port;
  }

  // user info: name[:password][;param=value]…
  const paramSplit = userInfo.split(PARAM_SEP);
  const credentials = paramSplit.shift() || '';
  for (const param of paramSplit) {
    if (!param) continue;
    const eq = param.indexOf(PARAM_VALUE_SEP);
    const name = decodeUrlPart(eq < 0 ? param : param.slice(0, eq));
    const value = eq < 0 ? '' : decodeUrlPart(param.slice(eq + 1));
    if (name.toLowerCase() === HOSTKEY_PARAM) out.hostKey = value;
    else if (name.toLowerCase().startsWith(RAW_PREFIX)) out.rawSettings[name.slice(RAW_PREFIX.length)] = value;
  }

  const colon = credentials.indexOf(':');
  out.userName = decodeUrlPart(colon < 0 ? credentials : credentials.slice(0, colon));
  if (colon >= 0) { out.hasPassword = true; out.password = decodeUrlPart(credentials.slice(colon + 1)); }

  // path: /dir/dir[;save]
  const pathParams = pathPart.split(PARAM_SEP);
  const dir = pathParams.shift() || '';
  for (const param of pathParams) {
    const eq = param.indexOf(PARAM_VALUE_SEP);
    const name = (eq < 0 ? param : param.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? '1' : param.slice(eq + 1);
    if (name === SAVE_PARAM) out.saveOnly = value !== '0';
  }
  if (dir && dir !== '/') out.remoteDirectory = decodeUrlPart(dir);

  if (!out.hostName) return { ok: false, error: 'The URL has no host name.' };
  if (!out.portDefined && !matched) out.portNumber = defaultPortFor(out.protocol, out.ftps);
  return out;
}

/** Turn a parse result into a site patch the Login form can apply directly. */
export function siteFromParsedUrl(parsed) {
  if (!parsed || !parsed.ok) return null;
  const patch = {
    protocol: parsed.protocol,
    ftps: parsed.ftps,
    hostName: parsed.hostName,
    portNumber: parsed.portNumber,
    userName: parsed.userName,
    remoteDirectory: parsed.remoteDirectory || '',
  };
  if (parsed.hasPassword) { patch.password = parsed.password; patch.savePassword = true; }
  if (parsed.hostKey) patch.hostKey = parsed.hostKey;
  for (const [k, v] of Object.entries(parsed.rawSettings || {})) {
    const key = RAW_SETTING_KEYS[k.toLowerCase()];
    if (!key) continue;
    patch[key] = coerceRawSetting(key, v);
  }
  return patch;
}

/** The `x-` names buildSessionUrl writes, mapped back onto session keys. */
const RAW_SETTING_KEYS = {
  ftps: 'ftps', ftppasvmode: 'ftpPasvMode', compression: 'compression',
  publickeyfile: 'publicKeyFile', s3defaultregion: 's3DefaultRegion',
  s3urlstyle: 's3UrlStyle', timeout: 'timeout', tunnel: 'tunnel',
  tunnelhostname: 'tunnelHostName', tunnelportnumber: 'tunnelPortNumber',
  tunnelusername: 'tunnelUserName', proxymethod: 'proxyMethod',
  proxyhost: 'proxyHost', proxyport: 'proxyPort', fsprotocol: 'protocol',
};

function coerceRawSetting(key, value) {
  const numeric = ['portNumber', 'timeout', 'tunnelPortNumber', 'proxyPort'];
  const boolean = ['ftpPasvMode', 'compression', 'tunnel'];
  if (numeric.includes(key)) return Number(value) || 0;
  if (boolean.includes(key)) return value !== '0' && value !== 'false';
  if (key === 'protocol') return String(value).toLowerCase() === 'sftponly' ? 'sftp' : String(value).toLowerCase();
  return value;
}

/* ------------------------------------------------------------------ */
/* scripting snippets                                                  */
/* ------------------------------------------------------------------ */

export const SCRIPT_FORMATS = Object.freeze([
  { id: 'script', label: 'Script file', ext: '.txt' },
  { id: 'batch', label: 'Batch file', ext: '.bat' },
  { id: 'commandline', label: 'Command-line', ext: '.txt' },
  { id: 'powershell', label: 'PowerShell script', ext: '.ps1' },
]);

const EXE = 'winscp.com';
const LOG_PATH = 'C:\\path\\to\\WinSCP.log';

/** Quote a value for the WinSCP scripting language ("" doubles a quote). */
export function quoteScriptParam(value) {
  const s = String(value ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * The `open …` line plus its switches, shared by all four formats.
 * The host key rides as a `-hostkey` switch rather than a `;fingerprint=`
 * URL parameter — GenerateOpenCommandArgs() does the same, and repeating it in
 * both places would put the fingerprint on the line twice.
 */
export function openCommandFor(site = {}, flags = {}) {
  const url = buildSessionUrl(site, {
    ...flags, hostKey: false, rawSettings: false, winscpSpecific: false, saveExtension: false,
  });
  let line = `open ${quoteScriptParam(url)}`;
  if (flags.hostKey && site.hostKey) line += ` -hostkey=${quoteScriptParam(site.hostKey)}`;
  if (site.publicKeyFile) line += ` -privatekey=${quoteScriptParam(site.publicKeyFile)}`;
  if (site.protocol === 'ftp' && site.ftpPasvMode === false) line += ' -passive=off';
  if (Number(site.timeout) && Number(site.timeout) !== 15) line += ` -timeout=${Number(site.timeout)}`;
  // No placeholder for a missing password: a literal `<file>` in a batch file
  // is a redirection operator, and a generated script that fails to run is
  // worse than one that prompts. The dialog says so in words instead.
  return line;
}

/**
 * buildScript(site, format, flags) -> { text, description, includesSecret }
 * The commands are identical across the four formats; only the wrapping
 * changes, exactly as GenerateScript() does it.
 */
export function buildScript(site = {}, format = 'script', flags = {}) {
  const commands = [openCommandFor(site, flags)];
  const dir = site.remoteDirectory && site.remoteDirectory !== '/' ? site.remoteDirectory : '';
  if (dir) commands.push(`cd ${quoteScriptParam(dir)}`);
  if (site.localDirectory) commands.push(`lcd ${quoteScriptParam(site.localDirectory)}`);
  commands.push('exit');

  const includesSecret = urlIncludesSecret(site, flags);
  const noPassword = !includesSecret && !!site.password;
  const passwordNote = noPassword
    ? ' The password is not included; the script will prompt for it, or pass one with the open command’s -password switch.'
    : '';
  const logSwitch = `/log="${LOG_PATH}"`;
  // /ini=nul keeps the scripting run from touching the interactive settings.
  const iniSwitch = '/ini=nul';

  switch (format) {
    case 'batch': {
      // A continuation caret goes at the END of every line that is followed by
      // another; a dangling caret on the last one would swallow the blank line
      // after it and take `set WINSCP_RESULT` with it.
      const body = commands.map((c) => `    "${c.replace(/%/g, '%%').replace(/"/g, '""')}"`);
      const lines = ['@echo off', '', `"${EXE}" ^`, `  ${logSwitch} ${iniSwitch} ^`,
        `  /command${body.length ? ' ^' : ''}`,
        ...body.map((l, i) => (i < body.length - 1 ? `${l} ^` : l))];
      lines.push('', 'set WINSCP_RESULT=%ERRORLEVEL%', 'if %WINSCP_RESULT% equ 0 (',
        '  echo Success', ') else (', '  echo Error', ')', '', 'exit /b %WINSCP_RESULT%');
      return {
        text: lines.join('\n'),
        description: `A batch file that runs the whole session unattended and exits with WinSCP\u2019s own exit code.${passwordNote}`,
        includesSecret,
      };
    }
    case 'commandline': {
      const parts = [logSwitch, iniSwitch, '/command'];
      commands.forEach((c) => parts.push(`"${c.replace(/"/g, '\\"')}"`));
      return {
        text: parts.join(' '),
        description: `Command-line arguments for the scripting host. Paste them after the executable name.${passwordNote}`,
        includesSecret,
      };
    }
    case 'powershell': {
      const body = commands.map((c) => {
        const escaped = c.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '""');
        return `    "${escaped}"`;
      });
      const lines = [
        '# Needed for PowerShell 7.3 and newer',
        '$PSNativeCommandArgumentPassing = "Legacy"',
        '',
        `& "${EXE}" \``,
        `  ${logSwitch} ${iniSwitch} \``,
        `  /command${body.length ? ' `' : ''}`,
        ...body.map((l, i) => (i < body.length - 1 ? `${l} \`` : l)),
      ];
      lines.push('', '$winscpResult = $LastExitCode', 'if ($winscpResult -eq 0)', '{',
        '  Write-Host "Success"', '}', 'else', '{', '  Write-Host "Error"', '}', '', 'exit $winscpResult');
      return {
        text: lines.join('\n'),
        description: `A PowerShell script. $PSNativeCommandArgumentPassing is set because PowerShell 7.3 changed how native arguments are quoted.${passwordNote}`,
        includesSecret,
      };
    }
    case 'script':
    default: {
      const lines = [...commands, '',
        '# Save the lines above to a file and run:',
        `# "${EXE}" ${logSwitch} ${iniSwitch} /script="path_to_script"`];
      return {
        text: lines.join('\n'),
        description: `A plain script file. Every line is one WinSCP scripting command.${passwordNote}`,
        includesSecret,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* .NET assembly snippets                                              */
/* ------------------------------------------------------------------ */

export const ASSEMBLY_LANGUAGES = Object.freeze([
  { id: 'csharp', label: 'C#' },
  { id: 'vbnet', label: 'VB.NET' },
  { id: 'powershell', label: 'PowerShell' },
]);

const NET_PROTOCOL = { sftp: 'Sftp', scp: 'Scp', ftp: 'Ftp', webdav: 'Webdav', s3: 'S3' };

function csString(value) { return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function vbString(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function psString(value) { return `"${String(value ?? '').replace(/`/g, '``').replace(/"/g, '""').replace(/\$/g, '`$')}"`; }

/**
 * buildAssemblyCode(site, language, flags) -> { text, description, includesSecret }
 *
 * `includesSecret` is ALWAYS false. The generator emits a null with a comment
 * where the password would go, and the dialog explains why beside the box —
 * silently dropping it would leave the reader thinking the snippet works
 * as-is against a password-protected account.
 */
export function buildAssemblyCode(site = {}, language = 'csharp', flags = {}) {
  const proto = NET_PROTOCOL[protocolInfo(site.protocol).id] || 'Sftp';
  const needsPassword = !!site.password;
  const port = isDefaultPort(site) ? null : Number(site.portNumber);
  const ftpSecure = site.protocol === 'ftp' && site.ftps !== 'none'
    ? (site.ftps === 'implicit' ? 'Implicit' : 'Explicit') : null;
  const wantHostKey = flags.hostKey !== false && !!site.hostKey;

  const rows = [];
  rows.push(['Protocol', `Protocol.${proto}`, 'enum']);
  if (site.hostName) rows.push(['HostName', site.hostName, 'string']);
  if (port) rows.push(['PortNumber', String(port), 'number']);
  if (site.userName) rows.push(['UserName', site.userName, 'string']);
  if (needsPassword) rows.push(['Password', null, 'secret']);
  if (wantHostKey) rows.push(['SshHostKeyFingerprint', site.hostKey, 'string']);
  if (site.publicKeyFile) rows.push(['SshPrivateKeyPath', site.publicKeyFile, 'string']);
  if (ftpSecure) rows.push(['FtpSecure', `FtpSecure.${ftpSecure}`, 'enum']);
  if (site.protocol === 'ftp' && site.ftpPasvMode === false) rows.push(['FtpMode', 'FtpMode.Active', 'enum']);
  if ((site.protocol === 'webdav' || site.protocol === 's3') && site.ftps !== 'none') {
    rows.push(['Secure', 'true', 'bool']);
  }
  if (site.timeout && Number(site.timeout) !== 15) rows.push(['Timeout', `TimeSpan.FromSeconds(${Number(site.timeout)})`, 'expr']);
  if (site.protocol === 's3' && site.s3DefaultRegion) rows.push(['S3DefaultRegion', site.s3DefaultRegion, 'raw']);

  const secretComment = 'Supply at run time \u2014 never commit a password to source control';

  if (language === 'vbnet') {
    const lines = ['\' Set up session options', 'Dim sessionOptions As New SessionOptions'];
    for (const [name, value, kind] of rows) {
      if (kind === 'secret') { lines.push(`sessionOptions.Password = Nothing \' ${secretComment}`); continue; }
      if (kind === 'raw') { lines.push(`sessionOptions.AddRawSettings("${name}", ${vbString(value)})`); continue; }
      lines.push(`sessionOptions.${name} = ${kind === 'string' ? vbString(value) : value}`);
    }
    lines.push('', 'Using session As New Session', '    session.Open(sessionOptions)', '',
      '    \' Your code here', 'End Using');
    return { text: lines.join('\n'), description: 'VB.NET using the WinSCP .NET assembly (WinSCPnet.dll).', includesSecret: false };
  }

  if (language === 'powershell') {
    const lines = ['# Load the WinSCP .NET assembly', 'Add-Type -Path "WinSCPnet.dll"', '',
      '# Set up session options', '$sessionOptions = New-Object WinSCP.SessionOptions -Property @{'];
    for (const [name, value, kind] of rows) {
      if (kind === 'secret') { lines.push(`    Password = $null   # ${secretComment}`); continue; }
      if (kind === 'raw') continue;
      if (kind === 'enum') { lines.push(`    ${name} = [WinSCP.${value.split('.')[0]}]::${value.split('.')[1]}`); continue; }
      lines.push(`    ${name} = ${kind === 'string' ? psString(value) : value}`);
    }
    lines.push('}');
    for (const [name, value, kind] of rows) {
      if (kind === 'raw') lines.push(`$sessionOptions.AddRawSettings("${name}", ${psString(value)})`);
    }
    lines.push('', '$session = New-Object WinSCP.Session', 'try', '{',
      '    $session.Open($sessionOptions)', '', '    # Your code here', '}', 'finally', '{',
      '    $session.Dispose()', '}');
    return { text: lines.join('\n'), description: 'PowerShell using the WinSCP .NET assembly (WinSCPnet.dll).', includesSecret: false };
  }

  const lines = ['// Set up session options', 'var sessionOptions = new SessionOptions', '{'];
  for (const [name, value, kind] of rows) {
    if (kind === 'secret') { lines.push(`    Password = null, // ${secretComment}`); continue; }
    if (kind === 'raw') continue;
    lines.push(`    ${name} = ${kind === 'string' ? csString(value) : value},`);
  }
  lines.push('};');
  for (const [name, value, kind] of rows) {
    if (kind === 'raw') lines.push(`sessionOptions.AddRawSettings(${csString(name)}, ${csString(value)});`);
  }
  lines.push('', 'using (var session = new Session())', '{', '    session.Open(sessionOptions);', '',
    '    // Your code here', '}');
  return { text: lines.join('\n'), description: 'C# using the WinSCP .NET assembly (WinSCPnet.dll).', includesSecret: false };
}

/* ================================================================== */
/* the dialog                                                          */
/* ================================================================== */

const TABS = [
  { id: 'url', labelKey: 'urlTab' },
  { id: 'script', labelKey: 'scriptTab' },
  { id: 'net', labelKey: 'netTab' },
];

/**
 * Build the dialog body. Exported so the Login dialog can embed it, and so a
 * host that already has a modal open does not have to nest two.
 */
export function createGenerateUrlPanel(site = {}, opts = {}) {
  installSessionDialogStyles();

  const state = {
    tab: opts.tab || 'url',
    flags: { ...DEFAULT_URL_FLAGS, ...(opts.flags || {}) },
    scriptFormat: opts.scriptFormat || 'script',
    assemblyLanguage: opts.assemblyLanguage || 'csharp',
  };

  const tabBar = h('div', { class: 'gu-tabs', role: 'tablist', 'aria-label': t('genUrlTitle') });
  const optionsHost = h('div', { class: 'stack' });
  const descriptionEl = h('p', { class: 'sd-hint prose' });
  const warnEl = h('div', { class: 'sd-note is-warn', hidden: true });
  const resultId = uid('gu-result');
  const resultEl = h('textarea', {
    class: 'gu-result', id: resultId, readonly: true, spellcheck: 'false', rows: 10,
    'aria-label': 'Generated text',
  });
  appearanceTarget(resultEl, 'generate-url-result', 'Generated code box');

  const panelIds = new Map(TABS.map((tb) => [tb.id, uid(`gu-panel-${tb.id}`)]));
  const tabIds = new Map(TABS.map((tb) => [tb.id, uid(`gu-tab-${tb.id}`)]));

  for (const tab of TABS) {
    const btn = h('button', {
      type: 'button', class: 'gu-tab', role: 'tab', id: tabIds.get(tab.id),
      'aria-controls': panelIds.get(tab.id),
      'aria-selected': String(state.tab === tab.id),
      tabindex: state.tab === tab.id ? '0' : '-1',
      'data-tab': tab.id,
      onclick: () => setTab(tab.id),
    });
    bindText(btn, tab.labelKey);
    tabBar.appendChild(btn);
  }
  tabBar.addEventListener('keydown', (e) => {
    const order = TABS.map((tb) => tb.id);
    const i = order.indexOf(state.tab);
    if (e.key === 'ArrowRight') { e.preventDefault(); setTab(order[(i + 1) % order.length], true); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); setTab(order[(i - 1 + order.length) % order.length], true); }
    else if (e.key === 'Home') { e.preventDefault(); setTab(order[0], true); }
    else if (e.key === 'End') { e.preventDefault(); setTab(order[order.length - 1], true); }
  });

  /* ---- URL options: seven checkboxes, each with its own explanation ---- */
  const flagSearch = createSearchBar({
    id: 'generate-url-options',
    persist: false,
    compact: true,
    labelKey: 'search',
    placeholder: 'Search these options',
    sampleProvider: () => URL_FLAGS.map((f) => `${f.label}\n${f.hint}`).join('\n'),
    onChange: () => renderOptions(),
  });

  function urlOptionRows() {
    const rows = URL_FLAGS.slice();
    if (!flagSearch.isActive) return rows;
    return filterBy(rows, flagSearch.predicate, (f) => [f.label, f.hint]);
  }

  function renderOptions() {
    clear(optionsHost);
    if (state.tab === 'url') {
      optionsHost.appendChild(flagSearch.element);
      const grid = h('div', { class: 'gu-opts' });
      const rows = urlOptionRows();
      if (!rows.length) {
        optionsHost.appendChild(h('p', { class: 'sd-hint' }, noMatchMessage(flagSearch.predicate, 'the URL options')));
      }
      for (const flag of rows) {
        const id = uid('gu-flag');
        const input = h('input', {
          type: 'checkbox', id,
          onchange: () => { state.flags[flag.id] = input.checked; paint(); },
        });
        input.checked = !!state.flags[flag.id];
        if (flag.id === 'password' && !site.password) {
          input.disabled = true;
          input.checked = false;
          state.flags.password = false;
        }
        const label = h('label', { class: `sd-check${input.disabled ? ' is-disabled' : ''}`, for: id, title: flag.hint },
          input, h('span', { class: 'sd-check-text' }, flag.label,
            h('span', { class: 'sd-hint', style: { display: 'block' } },
              input.disabled ? 'No password is stored for this site.' : flag.hint)));
        grid.appendChild(label);
      }
      optionsHost.appendChild(grid);
      return;
    }

    if (state.tab === 'script') {
      optionsHost.appendChild(selectRow('Format', SCRIPT_FORMATS, state.scriptFormat,
        (v) => { state.scriptFormat = v; paint(); }));
      return;
    }

    optionsHost.appendChild(selectRow('Language', ASSEMBLY_LANGUAGES, state.assemblyLanguage,
      (v) => { state.assemblyLanguage = v; paint(); }));
  }

  function selectRow(labelText, items, value, onChange) {
    const id = uid('gu-sel');
    const select = h('select', { class: 'sd-input', id, onchange: () => onChange(select.value) },
      ...items.map((it) => h('option', { value: it.id }, it.label)));
    select.value = value;
    return h('div', { class: 'sd-grid' },
      h('label', { class: 'sd-label', for: id }, labelText),
      select);
  }

  function setTab(id, focus = false) {
    state.tab = id;
    for (const btn of tabBar.querySelectorAll('.gu-tab')) {
      const on = btn.dataset.tab === id;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      if (on && focus) btn.focus();
    }
    resultEl.setAttribute('aria-labelledby', tabIds.get(id));
    resultEl.id = panelIds.get(id);
    paint();
  }

  function currentResult() {
    if (state.tab === 'script') return buildScript(site, state.scriptFormat, state.flags);
    if (state.tab === 'net') return buildAssemblyCode(site, state.assemblyLanguage, state.flags);
    return {
      text: buildSessionUrl(site, state.flags),
      description: 'A session URL. Opening it connects to this site.',
      includesSecret: urlIncludesSecret(site, state.flags),
    };
  }

  function paint() {
    renderOptions();
    const result = currentResult();
    resultEl.value = result.text;
    resultEl.rows = Math.min(20, Math.max(6, result.text.split('\n').length + 1));
    descriptionEl.textContent = result.description;
    clear(warnEl);
    if (result.includesSecret) {
      warnEl.hidden = false;
      warnEl.append(icon('warning', 15),
        h('span', {}, 'This text contains the stored password in clear. Anyone who can read it can use the account.'));
    } else if (state.tab === 'net' && site.password) {
      warnEl.hidden = false;
      warnEl.classList.remove('is-warn');
      clear(warnEl);
      warnEl.append(icon('info', 15),
        h('span', {}, 'The password is deliberately left as null: generated code is committed to repositories, so this snippet never carries a secret. Supply it at run time.'));
    } else {
      warnEl.hidden = true;
      warnEl.classList.add('is-warn');
    }
  }

  async function copyAll() {
    const ok = await copyText(resultEl.value);
    if (ok) { notify.success(t('copiedClip'), t('genUrlTitle')); announce(t('copiedClip')); }
    else notify.error(t('copyClip'), 'The clipboard refused the copy. The text is selected — press Ctrl+C.');
    resultEl.focus();
    resultEl.select();
  }

  const element = h('div', { class: 'stack sd-wide sd-wide-md' },
    h('div', { class: 'sd-hint' }, `${t('siteName')}: ${siteLabel(site)}`),
    tabBar,
    optionsHost,
    descriptionEl,
    warnEl,
    resultEl);

  setTab(state.tab);

  return {
    element,
    copyAll,
    get text() { return resultEl.value; },
    get state() { return { ...state }; },
    destroy() { flagSearch.destroy(); element.remove(); },
  };
}

let installed = false;

/**
 * Deferred registration: this module imports app.js, and app.js's registries
 * are still in their temporal dead zone while this module body runs if the
 * import graph ever closes the loop. Every dialog in this directory registers
 * from a microtask for the same reason.
 */
export function registerGenerateUrlDialog() {
  if (installed) return;
  installed = true;
  registerDialog('generateUrl', ({ props }) => {
    const panel = createGenerateUrlPanel(props.site || {}, props);
    return {
      title: t('genUrlTitle'),
      width: 760,
      content: panel.element,
      onClose: () => panel.destroy(),
      actions: [
        { label: t('copyClip'), kind: 'text', onSelect: () => { panel.copyAll(); return true; } },
        { label: t('close'), kind: 'filled', autofocus: true },
      ],
    };
  });
}

/** Open Generate URL/Code for a site. */
export function openGenerateUrl(site, opts = {}) {
  registerGenerateUrlDialog();
  return openDialog('generateUrl', { site, ...opts });
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { registerGenerateUrlDialog(); } catch (err) { console.error('[generateUrl] registration failed', err); }
  });
}
