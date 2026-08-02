// sessiondata.js — WinSCP's session-data model and, above all, its
// serialization: core/SessionData.cpp (TSessionData / TStoredSessionList).
//
// The interesting part of TSessionData is not the ~180 properties, it is the
// four different shapes the same data has to take and survive a round trip
// through:
//
//   1. the INI store        — `[Sessions\<name>]` with `Key=Value` lines, where
//                             ONLY options differing from the factory default
//                             are written. That rule is the entire reason a
//                             WinSCP.ini stays readable, and it is why every
//                             save here needs a baseline to compare against.
//   2. the session URL      — `sftp://user:pass;fingerprint=...;x-key=value@host:port/path`
//   3. the raw-settings text— the `Name=Value` list the Advanced > Raw settings
//                             dialog edits and `-rawsettings` carries.
//   4. the PuTTY session    — the same keys under different names, with a few
//                             deliberate divergences (see PUTTY_EXPORT below).
//
// `defaults.js` is the schema: it declares the option set and this port's
// default for each. WinSCP's own factory defaults differ for a handful of
// options (listed in WINSCP_FACTORY_OVERRIDES), and those — not this port's UI
// defaults — are what the INI's defaults-vs-explicit rule is defined against.
// Getting that wrong would silently change the meaning of every key a real
// WinSCP.ini omits, so the two are kept separate and only the WinSCP set is
// used as a serialization baseline.
//
// Secrets: this module holds passwords as plain strings in memory (config.js
// owns protection at rest via crypto.js) and never writes one anywhere without
// being asked. Everything that produces text a user might see or paste —
// generateSessionUrl, generateOpenCommandArgs, logging helpers — masks them.
'use strict';

const { SESSION_DEFAULTS } = require('./defaults');
const {
  PASSWORD_MASK, Options, escapeParam, stringsToParams, tryStrToInt,
} = require('./options');

/* ================================================================== */
/* constants — the ones the C++ exports and other units depend on      */
/* ================================================================== */

const SSH_PORT = 22;
const FTP_PORT = 21;
const FTPS_IMPLICIT_PORT = 990;
const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const PROXY_PORT = 80;
const DEFAULT_SEND_BUF = 262144;

const ANONYMOUS_USER_NAME = 'anonymous';
const ANONYMOUS_PASSWORD = 'anonymous@example.com';

const WINSCP_PROTOCOL_PREFIX = 'winscp-';
const URL_PARAM_SEPARATOR = ';';
const URL_PARAM_VALUE_SEPARATOR = '=';
const URL_HOSTKEY_PARAM_NAME = 'fingerprint';
const URL_SAVE_PARAM_NAME = 'save';
const URL_RAW_SETTINGS_PARAM_PREFIX = 'x-';
const PASSPHRASE_OPTION = 'passphrase';
const RAW_SETTINGS_OPTION = 'rawsettings';
const SESSION_NAME_SETTINGS_NAME = 'Name';

const S3_HOST_NAME = 's3.amazonaws.com';
const S3_GOOGLE_CLOUD_HOST_NAME = 'storage.googleapis.com';

/**
 * core/Global.cpp's `EmptyString` magic value. WinSCP needs to tell "no
 * password was given, ask for one" apart from "the password is empty", and a
 * plain empty string cannot say both. DenormalizeString stamps this in and
 * NormalizeString takes it back out; it never leaves the module.
 */
const EMPTY_STRING_MARKER = '\x01\x01\x01';

/** TNamedObjectList::HiddenPrefix — a site name so prefixed is not listed. */
const HIDDEN_PREFIX = '_!_';
/** The reserved name of the stored "Default Settings" pseudo-site. */
const DEFAULT_SETTINGS_NAME = 'Default Settings';
/** TitleSeparator: an en-dash, used in the local-browser session name. */
const TITLE_SEPARATOR = ' – ';

/** TSessionUrlFlags. */
const SUF = {
  SPECIFIC: 0x01,
  USERNAME: 0x02,
  PASSWORD: 0x04,
  HOSTKEY: 0x08,
  RAWSETTINGS: 0x10,
  HTTP_FOR_WEBDAV: 0x20,
};
SUF.SESSION = SUF.USERNAME | SUF.PASSWORD | SUF.HOSTKEY;
SUF.COMPLETE = SUF.SESSION | SUF.RAWSETTINGS;
SUF.OPEN = SUF.USERNAME | SUF.PASSWORD;

/** TParseUrlFlags. */
const PUF = {
  ALLOW_STORED_SITE_WITH_PROTOCOL: 0x01,
  UNSAFE: 0x02,
  PREFER_PROTOCOL: 0x04,
  PARSE_ONLY: 0x08,
};

/** TParsedInfoFlags. */
const PI = {
  DEFAULTS_ONLY: 0x01,
  PROTOCOL_DEFINED: 0x02,
  UNSAFE_SETTINGS: 0x04,
};

/** TSessionSource. */
const SOURCE = { NONE: 'none', STORED: 'stored', STORED_MODIFIED: 'storedModified' };

/* ------------------------------ enums ----------------------------- */

/** TFSProtocol. The gaps (3, 4) are the obsoleted external SCP/SFTP entries. */
const FS_PROTOCOL = { scp: 0, sftp: 1, sftpOnly: 2, ftp: 5, webdav: 6, s3: 7 };
/** WinSCP's own display names, indexed by TFSProtocol. */
const FS_PROTOCOL_NAMES = { scp: 'SCP', sftp: 'SFTP', sftpOnly: 'SFTP', ftp: 'FTP', webdav: 'WebDAV', s3: 'S3' };

/** TAutoSwitch — asOn, asOff, asAuto. Note that 'auto' is 2, not 0. */
const AUTO_SWITCH = { on: 0, off: 1, auto: 2 };
/**
 * AutoSwitchReversedMapping: only used when a *textual* value is read for the
 * `Utf` key, where "on" means UTF is on, i.e. NotUtf is off.
 */
const AUTO_SWITCH_REVERSED = { on: 1, off: 0, auto: 2 };

const PING_TYPE = { off: 0, null: 1, dummy: 2 };
/** FtpPingTypeNames is "Off;Dummy;Dummy;List" — 1 is a legacy alias of 2. */
const FTP_PING_TYPE = { off: 0, dummy: 2, directory: 3 };
const FTP_PING_TYPE_READ = { 0: 'off', 1: 'dummy', 2: 'dummy', 3: 'directory' };
const PROXY_METHOD = { none: 0, socks4: 1, socks5: 2, http: 3, telnet: 4, cmd: 5, system: 6 };
const ADDRESS_FAMILY = { auto: 0, ipv4: 1, ipv6: 2 };
const FTPS = { none: 0, implicit: 1, explicitSsl: 2, explicitTls: 3 };
/** TDSTMode: dstmWin = 0, dstmUnix = 1, dstmKeep = 2. */
const DST_MODE = { win: 0, unix: 1, keep: 2 };
/** TEOLType. */
const EOL_TYPE = { lf: 0, crlf: 1, cr: 2 };
const S3_URL_STYLE = { virtualhost: 0, path: 1 };
/** TTlsVersion. ssl2/ssl3 are read as tls10; they are never written. */
const TLS_VERSION = { tls10: 10, tls11: 11, tls12: 12, tls13: 13 };
const TLS_VERSION_READ = { 2: 'tls10', 3: 'tls10', 10: 'tls10', 11: 'tls11', 12: 'tls12', 13: 'tls13' };

/** Algorithm names, in the order the enums declare them (the stored order). */
const CIPHER_NAMES = ['WARN', '3des', 'blowfish', 'aes', 'des', 'arcfour', 'chacha20', 'aesgcm'];
const KEX_NAMES = ['WARN', 'dh-group1-sha1', 'dh-group14-sha1', 'dh-group15-sha512',
  'dh-group16-sha512', 'dh-group17-sha512', 'dh-group18-sha512', 'dh-gex-sha1', 'rsa',
  'ecdh', 'ntru-curve25519', 'mlkem-curve25519', 'mlkem-nist'];
const HOSTKEY_NAMES = ['WARN', 'rsa', 'dsa', 'ecdsa', 'ed25519', 'ed448'];
const GSSLIB_NAMES = ['gssapi32', 'sspi', 'custom'];

/**
 * The factory *order* of each list. defaults.js carries this port's UI defaults,
 * which predate the post-quantum key exchanges and AES-GCM; the merge in
 * setAlgoList is defined against WinSCP's current list, so that is what lives
 * here.
 */
const DEFAULT_CIPHER_LIST = ['aes', 'chacha20', 'aesgcm', '3des', 'WARN', 'des', 'blowfish', 'arcfour'];
const DEFAULT_KEX_LIST = ['ntru-curve25519', 'mlkem-curve25519', 'mlkem-nist', 'ecdh',
  'dh-gex-sha1', 'dh-group18-sha512', 'dh-group17-sha512', 'dh-group16-sha512',
  'dh-group15-sha512', 'dh-group14-sha1', 'rsa', 'WARN', 'dh-group1-sha1'];
const DEFAULT_HOSTKEY_LIST = ['ed448', 'ed25519', 'ecdsa', 'rsa', 'dsa', 'WARN'];
const DEFAULT_GSSLIB_LIST = ['gssapi32', 'sspi', 'custom'];

/** The ten PuTTY bug workarounds, in TSshBug order. INI key is `Bug<name>`. */
const SSH_BUG_KEYS = ['HMAC2', 'DeriveKey2', 'RSAPad2', 'PKSessID2', 'Rekey2',
  'MaxPkt2', 'Ignore2', 'OldGex2', 'WinAdj', 'ChanReq'];
/** Our field names for them, keyed by the INI suffix. */
const SSH_BUG_FIELDS = {
  HMAC2: 'hmac2', DeriveKey2: 'deriveKey2', RSAPad2: 'rsaPad2', PKSessID2: 'pkSessID2',
  Rekey2: 'rekey2', MaxPkt2: 'maxPkt2', Ignore2: 'ignore2', OldGex2: 'oldGex2',
  WinAdj: 'winAdj', ChanReq: 'chanReq',
};

/**
 * PuTTY host-key algorithm ids, used to split a stored host key into its
 * algorithm name and fingerprint when generating a URL.
 */
const HOSTKEY_ALG_IDS = ['ssh-ed25519', 'ssh-ed448', 'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-256', 'rsa-sha2-512',
  'ssh-rsa', 'ssh-dss'];
const NORMALIZED_FINGERPRINT_SEPARATOR = '-';

/* ================================================================== */
/* the option set                                                      */
/* ================================================================== */

/**
 * Fields TSessionData has that defaults.js does not declare. They are real
 * options — several are reachable only through raw settings in WinSCP too —
 * and leaving them out would make every load/save lossy.
 */
const EXTRA_SESSION_FIELDS = {
  newPassword: '',
  changePassword: false,
  changeUsername: false,
  ssh2DES: false,
  sshSimple: true,
  tcpNoDelay: false,
  logicalHostName: '',
  gssLibCustom: '',
  internalEditorEncoding: -1,
  s3RoleSessionName: '',
  exitCode1IsError: false,
  otherLocalDirectory: '',
  requireDirectories: false,
  special: false,
  selected: false,
  isWorkspace: false,
  link: '',
  nameOverride: '',
  winTitle: '',
  webDavCrossDomainRedirects: false,
  webDavUnencryptedRedirects: false,
  puttySettings: '',
  customParam1: '',
  customParam2: '',
  ftpProxyLogonType: 0,
  ftpWorkFromCwd: 'auto',
  ftpAnyCodeForPwd: false,
  completeTlsShutdown: 'auto',
  tunnelPortFwd: '',
  sshBugs: {
    hmac2: 'auto', deriveKey2: 'auto', rsaPad2: 'auto', pkSessID2: 'auto', rekey2: 'auto',
    maxPkt2: 'auto', ignore2: 'auto', oldGex2: 'auto', winAdj: 'auto', chanReq: 'auto',
  },
  // Not persisted; parseUrl and the site list set them.
  name: '',
  source: SOURCE.NONE,
  saveOnly: false,
  overrideCachedHostKey: true,
  modified: false,
};

/**
 * Where WinSCP's factory default differs from this port's UI default. Only
 * these values decide whether a key is written to an INI, so they must match
 * the C++ exactly or a WinSCP-written file changes meaning when reloaded.
 */
const WINSCP_FACTORY_OVERRIDES = {
  authGSSAPI: true,              // DefaultSettings(): AuthGSSAPI = true
  sftpUploadQueue: 64,           // defaults.js says 32
  sftpMaxVersion: -1,            // SFTPMaxVersionAuto
  recycleBinPath: '',            // defaults.js pre-fills '/tmp' for the UI
  minTlsVersion: 'tls12',        // tlsDefaultMin
  fingerprintScan: false,
  proxyHost: 'proxy',
  proxyPort: PROXY_PORT,
  cipherList: DEFAULT_CIPHER_LIST,
  kexList: DEFAULT_KEX_LIST,
  hostKeyList: DEFAULT_HOSTKEY_LIST,
  gssLibList: DEFAULT_GSSLIB_LIST,
};

function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepClone(v[k]);
    return o;
  }
  return v;
}

/** The complete field set: defaults.js's schema plus WinSCP's extras. */
const SESSION_DATA_DEFAULTS = Object.freeze(
  deepClone({ ...SESSION_DEFAULTS, ...EXTRA_SESSION_FIELDS }));

/** TSessionData::Default() — the baseline every load starts from. */
const FACTORY_DEFAULTS = Object.freeze(
  deepClone({ ...SESSION_DATA_DEFAULTS, ...WINSCP_FACTORY_OVERRIDES }));

/** A fresh TSessionData. */
function defaultSessionData(name = '') {
  const d = deepClone(FACTORY_DEFAULTS);
  d.name = name;
  return d;
}

/** The site template a new site in *this app* starts from (defaults.js). */
function appDefaultSessionData(name = '') {
  const d = deepClone(SESSION_DATA_DEFAULTS);
  d.name = name;
  return d;
}

function cloneSessionData(data) { return deepClone(data); }

/* ================================================================== */
/* string munging — how a value survives an INI                        */
/* ================================================================== */

const BOM_BYTES = [0xEF, 0xBB, 0xBF];

/**
 * PuTTY's escape_registry_key. Space, backslash, `*`, `?`, `%`, any control or
 * non-ASCII byte and a leading `.` become `%XX`. Operates on bytes, so the
 * caller decides the encoding.
 */
function puttyEscapeBytes(bytes, isValue) {
  let out = '';
  let candot = false;
  const hex = '0123456789ABCDEF';
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (c === ' ' || c === '\\' || c === '*' || c === '?' || c === '%' ||
        b < 0x20 || b > 0x7E || (c === '.' && !candot)) {
      out += '%' + hex[b >> 4] + hex[b & 15];
    } else {
      out += c;
    }
    candot = true;
  }
  // A masked password must stay recognisable as `***`, so `*` is put back.
  if (isValue) out = out.split('%2A').join('*');
  return out;
}

function puttyUnescape(str) {
  const bytes = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '%' && i + 2 < str.length) {
      let hi = str.charCodeAt(i + 1) - 48; if (hi > 9) hi -= 7;
      let lo = str.charCodeAt(i + 2) - 48; if (lo > 9) lo -= 7;
      bytes.push(((hi << 4) + lo) & 0xFF);
      i += 3;
    } else {
      bytes.push(str.charCodeAt(i) & 0xFF);
      i++;
    }
  }
  return bytes;
}

/**
 * MungeStr. Non-ASCII text is stored as UTF-8 prefixed with a BOM so an old
 * reader can tell the two encodings apart; ASCII text is stored as-is apart
 * from the escapes above.
 */
function mungeStr(str, isValue = true) {
  const utf8 = Array.from(Buffer.from(String(str), 'utf8'));
  const bytes = utf8.length > String(str).length ? BOM_BYTES.concat(utf8) : utf8;
  return puttyEscapeBytes(bytes, isValue);
}

function unMungeStr(str) {
  const bytes = puttyUnescape(String(str));
  if (bytes.length >= 3 && bytes[0] === BOM_BYTES[0] && bytes[1] === BOM_BYTES[1] &&
      bytes[2] === BOM_BYTES[2]) {
    return Buffer.from(bytes.slice(3)).toString('utf8');
  }
  return Buffer.from(bytes).toString('latin1');
}

const ESCAPED_BOM = puttyEscapeBytes(BOM_BYTES, false);

/**
 * MungeIniName. Only non-ASCII names are actually rewritten: PuTTY's escaper
 * leaves `=` alone, so a name containing one comes back unchanged even though
 * it triggers the check. That is what the C++ does, and it is harmless because
 * no option name contains an equals sign — but the *reader* still has to
 * understand the `%3D` form an older WinSCP wrote, which unMungeIniName does.
 */
function mungeIniName(str) {
  let needs = false;
  for (const ch of String(str)) {
    if (ch.charCodeAt(0) > 0x7F || ch === '=') { needs = true; break; }
  }
  return needs ? mungeStr(str, false) : String(str);
}

function unMungeIniName(str) {
  if (String(str).startsWith(ESCAPED_BOM)) return unMungeStr(str);
  // Backward compatibility with versions that only escaped the equals sign.
  return String(str).includes('%3D') ? String(str).split('%3D').join('=') : String(str);
}

/* ================================================================== */
/* a storage: the INI section a session lives in                       */
/* ================================================================== */

/**
 * The minimum of THierarchicalStorage that TSessionData actually uses, over a
 * plain `{ Key: 'value' }` map of strings. `mungeValues` is false for the
 * PuTTY export path (ConfigureForPutty) and true everywhere else.
 */
class KeyValueStorage {
  constructor(values = {}, { mungeValues = true } = {}) {
    this.values = { ...values };
    this.mungeValues = mungeValues;
    /** Keys the save path explicitly removed, so a caller can mirror deletes. */
    this.deleted = [];
    this._reindex();
  }

  /**
   * Lookups are case-insensitive, because both a Delphi TIniFile and the
   * TStringList behind `-rawsettings` are. That is what makes the lowercased
   * `x-listingcommand=` parameter of a generated URL find `ListingCommand`
   * again when the URL is parsed back.
   */
  _reindex() {
    this._index = new Map();
    for (const k of Object.keys(this.values)) this._index.set(k.toLowerCase(), k);
  }

  _key(name) {
    const munged = mungeIniName(name);
    return this._index.get(String(munged).toLowerCase()) ??
      this._index.get(String(name).toLowerCase());
  }

  _raw(name) {
    const k = this._key(name);
    return k === undefined ? undefined : this.values[k];
  }

  valueExists(name) { return this._raw(name) !== undefined; }

  readStringRaw(name, def) {
    const v = this._raw(name);
    return v === undefined ? def : v;
  }

  readString(name, def) {
    const v = this._raw(name);
    if (v === undefined) return def;
    return this.mungeValues ? unMungeStr(v) : v;
  }

  /** ReadInteger / ReadEnum: a textual value is looked up in `mapping` first. */
  readInteger(name, def, mapping) {
    const v = this._raw(name);
    if (v === undefined) return def;
    if (mapping) {
      const mapped = mapping[String(v).toLowerCase()];
      if (mapped !== undefined) return mapped;
    }
    const n = tryStrToInt(v);
    return n === null ? def : n;
  }

  /** ReadBool goes through the integer path with an on/off mapping. */
  readBool(name, def) {
    const v = this._raw(name);
    if (v === undefined) return def;
    const lower = String(v).toLowerCase();
    if (lower === 'on') return true;
    if (lower === 'off') return false;
    const n = tryStrToInt(v);
    return n === null ? def : n !== 0;
  }

  readFloat(name, def) {
    const v = this._raw(name);
    if (v === undefined) return def;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : def;
  }

  writeStringRaw(name, value) {
    const munged = mungeIniName(name);
    const existing = this._key(name);
    const key = existing === undefined ? munged : existing;
    this.values[key] = String(value);
    this._index.set(key.toLowerCase(), key);
  }
  writeString(name, value) {
    this.writeStringRaw(name, this.mungeValues ? mungeStr(value, true) : String(value));
  }
  writeInteger(name, value) { this.writeStringRaw(name, String(Math.trunc(value))); }
  writeBool(name, value) { this.writeStringRaw(name, value ? '1' : '0'); }
  writeFloat(name, value) { this.writeStringRaw(name, String(value)); }

  deleteValue(name) {
    const key = this._key(name);
    if (key !== undefined) {
      delete this.values[key];
      this._index.delete(key.toLowerCase());
    }
    this.deleted.push(name);
  }

  /** The stored options as the `Name=Value` lines the raw dialog shows. */
  toLines() {
    return Object.keys(this.values).map((k) => `${k}=${this.values[k]}`);
  }
}

/** Build a storage from `Name=Value` lines (the raw-settings text format). */
function storageFromLines(lines, opts) {
  const values = {};
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    const p = line.indexOf('=');
    if (p < 0) continue;                          // TStrings.Names is '' with no '='
    values[line.slice(0, p)] = line.slice(p + 1);
  }
  return new KeyValueStorage(values, opts);
}

/**
 * The raw-settings text the Advanced dialog edits: one `Name=Value` per line,
 * blank lines and `;`/`#` comments ignored. A line with no `=` is not a
 * setting and is dropped, exactly as TStrings.Values would.
 */
function parseRawSettingsText(text) {
  const out = [];
  for (const rawLine of String(text).split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    if (!line.includes('=')) continue;
    out.push(line);
  }
  return out;
}

function formatRawSettingsText(lines) { return lines.join('\r\n'); }

/* ================================================================== */
/* the option table                                                    */
/* ================================================================== */
//
// One table drives load, save and "which options exist". `k` is the INI key,
// `f` the field in our session object, `t` the type. `alias` lists older or
// foreign keys read as a fallback (PuTTY's, and WinSCP's own renamed ones).
// `putty` decides where the option appears: 'both' (default), 'no' (never in a
// PuTTY export) or 'only'.

const T = {
  STR: 'string', RAW: 'raw', INT: 'int', BOOL: 'bool', FLOAT: 'float',
  ENUM: 'enum', LIST: 'list', LINES: 'lines', COLOR: 'color',
};

/** name→int maps for the ENUM type, plus their reverse. */
function reverseMap(map) {
  const r = {};
  for (const k of Object.keys(map)) if (r[map[k]] === undefined) r[map[k]] = k;
  return r;
}

const ENUMS = {
  fsProtocol: { to: FS_PROTOCOL, from: reverseMap(FS_PROTOCOL) },
  autoSwitch: { to: AUTO_SWITCH, from: reverseMap(AUTO_SWITCH), read: AUTO_SWITCH },
  autoSwitchReversed: { to: AUTO_SWITCH, from: reverseMap(AUTO_SWITCH), read: AUTO_SWITCH_REVERSED },
  pingType: { to: PING_TYPE, from: reverseMap(PING_TYPE) },
  ftpPingType: { to: FTP_PING_TYPE, from: FTP_PING_TYPE_READ },
  proxyMethod: { to: PROXY_METHOD, from: reverseMap(PROXY_METHOD), read: PROXY_METHOD },
  addressFamily: { to: ADDRESS_FAMILY, from: reverseMap(ADDRESS_FAMILY) },
  ftps: { to: FTPS, from: reverseMap(FTPS) },
  dstMode: { to: DST_MODE, from: reverseMap(DST_MODE) },
  eolType: { to: EOL_TYPE, from: reverseMap(EOL_TYPE) },
  s3UrlStyle: { to: S3_URL_STYLE, from: reverseMap(S3_URL_STYLE) },
  tlsVersion: { to: TLS_VERSION, from: TLS_VERSION_READ },
};

/**
 * The table, in DoSave order. Anything with special handling (passwords, the
 * ping interval split, the bug arrays, the tunnel block) is coded separately
 * below rather than forced into a declarative row.
 */
const OPTIONS = [
  { k: 'HostName', f: 'hostName', t: T.STR },
  { k: 'PortNumber', f: 'portNumber', t: T.INT },
  { k: 'PingType', f: 'pingType', t: T.ENUM, e: 'pingType' },
  { k: 'Timeout', f: 'timeout', t: T.INT },
  { k: 'TryAgent', f: 'tryAgent', t: T.BOOL },
  { k: 'AgentFwd', f: 'agentFwd', t: T.BOOL },
  { k: 'AuthKI', f: 'authKI', t: T.BOOL },
  { k: 'AuthKIPassword', f: 'authKIPassword', t: T.BOOL },
  { k: 'SshHostKey', f: 'hostKey', t: T.STR },
  { k: 'Note', f: 'note', t: T.STR },
  { k: 'AuthGSSAPI', f: 'authGSSAPI', t: T.BOOL, alias: ['AuthSSPI'] },
  { k: 'AuthGSSAPIKEX', f: 'authGSSAPIKEX', t: T.BOOL },
  { k: 'GSSAPIFwdTGT', f: 'gssapiFwdTGT', t: T.BOOL, alias: ['GssapiFwd', 'SSPIFwdTGT'] },
  { k: 'LogicalHostName', f: 'logicalHostName', t: T.STR, alias: ['GSSAPIServerRealm', 'KerbPrincipal'] },
  { k: 'ChangeUsername', f: 'changeUsername', t: T.BOOL },
  { k: 'Compression', f: 'compression', t: T.BOOL },
  { k: 'Ssh2DES', f: 'ssh2DES', t: T.BOOL },
  { k: 'SshNoUserAuth', f: 'sshNoUserAuth', t: T.BOOL },
  { k: 'Cipher', f: 'cipherList', t: T.LIST, names: CIPHER_NAMES, def: DEFAULT_CIPHER_LIST, warn: 'WARN' },
  { k: 'KEX', f: 'kexList', t: T.LIST, names: KEX_NAMES, def: DEFAULT_KEX_LIST, warn: 'WARN' },
  { k: 'HostKey', f: 'hostKeyList', t: T.LIST, names: HOSTKEY_NAMES, def: DEFAULT_HOSTKEY_LIST, warn: 'WARN' },
  { k: 'GSSLibs', f: 'gssLibList', t: T.LIST, names: GSSLIB_NAMES, def: DEFAULT_GSSLIB_LIST, warn: null, unsafe: true },
  { k: 'GSSCustom', f: 'gssLibCustom', t: T.STR },
  { k: 'AddressFamily', f: 'addressFamily', t: T.ENUM, e: 'addressFamily' },
  { k: 'RekeyBytes', f: 'rekeyData', t: T.STR },
  { k: 'RekeyTime', f: 'rekeyTime', t: T.INT },
  { k: 'TcpNoDelay', f: 'tcpNoDelay', t: T.BOOL, skipLoadOnPuttyImport: true },

  { k: 'UserName', f: 'userName', t: T.STR, puttyRaw: true },
  { k: 'PublicKeyFile', f: 'publicKeyFile', t: T.STR, puttyRaw: true },
  { k: 'DetachedCertificate', f: 'detachedCertificate', t: T.STR, puttyRaw: true },

  { k: 'FSProtocol', f: 'protocol', t: T.ENUM, e: 'fsProtocol', putty: 'no' },
  { k: 'LocalDirectory', f: 'localDirectory', t: T.STR, putty: 'no' },
  { k: 'OtherLocalDirectory', f: 'otherLocalDirectory', t: T.STR, putty: 'no' },
  { k: 'RemoteDirectory', f: 'remoteDirectory', t: T.STR, putty: 'no' },
  { k: 'SynchronizeBrowsing', f: 'synchronizeBrowsing', t: T.BOOL, putty: 'no' },
  { k: 'UpdateDirectories', f: 'updateDirectories', t: T.BOOL, putty: 'no' },
  { k: 'CacheDirectories', f: 'cacheDirectories', t: T.BOOL, putty: 'no' },
  { k: 'CacheDirectoryChanges', f: 'cacheDirectoryChanges', t: T.BOOL, putty: 'no' },
  { k: 'PreserveDirectoryChanges', f: 'preserveDirectoryChanges', t: T.BOOL, putty: 'no' },
  { k: 'ResolveSymlinks', f: 'resolveSymlinks', t: T.BOOL, putty: 'no' },
  { k: 'FollowDirectorySymlinks', f: 'followDirectorySymlinks', t: T.BOOL, putty: 'no' },
  { k: 'ConsiderDST', f: 'dSTMode', t: T.ENUM, e: 'dstMode', putty: 'no' },
  { k: 'Shell', f: 'shell', t: T.STR, putty: 'no', unsafe: true },
  { k: 'ClearAliases', f: 'clearAliases', t: T.BOOL, putty: 'no' },
  { k: 'UnsetNationalVars', f: 'unsetNationalVars', t: T.BOOL, putty: 'no' },
  { k: 'ListingCommand', f: 'listingCommand', t: T.STR, putty: 'no', unsafe: true },
  { k: 'IgnoreLsWarnings', f: 'ignoreLsWarnings', t: T.BOOL, putty: 'no' },
  { k: 'SCPLsFullTime', f: 'sCPLsFullTime', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'Scp1Compatibility', f: 'scp1Compatibility', t: T.BOOL, putty: 'no' },
  { k: 'TimeDifferenceAuto', f: 'timeDifferenceAuto', t: T.BOOL, putty: 'no' },
  { k: 'DeleteToRecycleBin', f: 'deleteToRecycleBin', t: T.BOOL, putty: 'no', unsafe: true },
  { k: 'OverwrittenToRecycleBin', f: 'overwrittenToRecycleBin', t: T.BOOL, putty: 'no', unsafe: true },
  { k: 'RecycleBinPath', f: 'recycleBinPath', t: T.STR, putty: 'no', unsafe: true },
  { k: 'PostLoginCommands', f: 'postLoginCommands', t: T.LINES, putty: 'no', unsafe: true },
  { k: 'ReturnVar', f: 'returnVar', t: T.STR, putty: 'no', unsafe: true },
  { k: 'ExitCode1IsError', f: 'exitCode1IsError', t: T.BOOL, putty: 'no' },
  { k: 'LookupUserGroups2', f: 'lookupUserGroups', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'EOLType', f: 'eolType', t: T.ENUM, e: 'eolType', putty: 'no' },
  { k: 'TrimVMSVersions', f: 'trimVMSVersions', t: T.BOOL, putty: 'no' },
  { k: 'VMSAllRevisions', f: 'vMSAllRevisions', t: T.BOOL, putty: 'no' },
  { k: 'Utf', f: 'notUtf', t: T.ENUM, e: 'autoSwitchReversed', alias: ['SFTPUtfBug'], putty: 'no' },
  { k: 'InternalEditorEncoding', f: 'internalEditorEncoding', t: T.INT, putty: 'no' },
  { k: 'S3DefaultRegion', f: 's3DefaultRegion', t: T.STR, putty: 'no' },
  { k: 'S3SessionToken', f: 's3SessionToken', t: T.STR, putty: 'no' },
  { k: 'S3RoleArn', f: 's3RoleArn', t: T.STR, putty: 'no' },
  { k: 'S3RoleSessionName', f: 's3RoleSessionName', t: T.STR, putty: 'no' },
  { k: 'S3Profile', f: 's3Profile', t: T.STR, putty: 'no' },
  { k: 'S3UrlStyle', f: 's3UrlStyle', t: T.ENUM, e: 's3UrlStyle', putty: 'no' },
  { k: 'S3MaxKeys', f: 's3MaxKeys', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'S3CredentialsEnv', f: 's3CredentialsEnv', t: T.BOOL, putty: 'no' },
  { k: 'S3RequesterPays', f: 's3RequesterPays', t: T.BOOL, putty: 'no' },
  { k: 'SendBuf', f: 'sendBuf', t: T.INT, alias: ['SshSendBuf'], putty: 'no' },
  { k: 'SourceAddress', f: 'sourceAddress', t: T.STR, putty: 'no' },
  { k: 'ProtocolFeatures', f: 'protocolFeatures', t: T.STR, putty: 'no' },
  { k: 'SshSimple', f: 'sshSimple', t: T.BOOL, putty: 'no' },

  { k: 'ProxyMethod', f: 'proxyMethod', t: T.ENUM, e: 'proxyMethod' },
  { k: 'ProxyHost', f: 'proxyHost', t: T.STR },
  { k: 'ProxyPort', f: 'proxyPort', t: T.INT },
  { k: 'ProxyUsername', f: 'proxyUsername', t: T.STR },
  { k: 'ProxyLocalhost', f: 'proxyLocalhost', t: T.BOOL },

  { k: 'SftpServer', f: 'sftpServer', t: T.STR, putty: 'no', unsafe: true },
  { k: 'SFTPSymlinkBug', f: 'sftpBugs.symlink', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'SFTPSignedTSBug', f: 'sftpBugs.signedTS', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'SFTPMaxVersion', f: 'sftpMaxVersion', t: T.INT, putty: 'no' },
  { k: 'SFTPMaxPacketSize', f: 'sftpMaxPacketSize', t: T.INT, putty: 'no' },
  { k: 'SFTPDownloadQueue', f: 'sftpDownloadQueue', t: T.INT, putty: 'no' },
  { k: 'SFTPUploadQueue', f: 'sftpUploadQueue', t: T.INT, putty: 'no' },
  { k: 'SFTPListingQueue', f: 'sftpListingQueue', t: T.INT, putty: 'no' },
  { k: 'SFTPRealPath', f: 'sftpRealPath', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'UsePosixRename', f: 'usePosixRename', t: T.BOOL, putty: 'no' },

  { k: 'Color', f: 'color', t: T.COLOR, putty: 'no' },

  { k: 'Tunnel', f: 'tunnel', t: T.BOOL, putty: 'no' },
  { k: 'TunnelHostName', f: 'tunnelHostName', t: T.STR, putty: 'no' },
  { k: 'TunnelPortNumber', f: 'tunnelPortNumber', t: T.INT, putty: 'no' },
  { k: 'TunnelUserName', f: 'tunnelUserName', t: T.STR, putty: 'no' },
  { k: 'TunnelPublicKeyFile', f: 'tunnelPublicKeyFile', t: T.STR, putty: 'no' },
  { k: 'TunnelLocalPortNumber', f: 'tunnelLocalPortNumber', t: T.INT, putty: 'no' },
  { k: 'TunnelHostKey', f: 'tunnelHostKey', t: T.STR, putty: 'no' },

  { k: 'FtpPasvMode', f: 'ftpPasvMode', t: T.BOOL, putty: 'no' },
  { k: 'FtpForcePasvIp2', f: 'ftpForcePasvIp', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'FtpUseMlsd', f: 'ftpUseMlsd', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'FtpAccount', f: 'ftpAccount', t: T.STR, putty: 'no' },
  { k: 'FtpPingInterval', f: 'ftpPingInterval', t: T.INT, putty: 'no' },
  { k: 'FtpPingType', f: 'ftpPingType', t: T.ENUM, e: 'ftpPingType', putty: 'no' },
  { k: 'FtpTransferActiveImmediately2', f: 'ftpTransferActiveImmediately', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'Ftps', f: 'ftps', t: T.ENUM, e: 'ftps', putty: 'no' },
  { k: 'FtpListAll', f: 'ftpListAll', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'FtpHost', f: 'ftpHost', t: T.ENUM, e: 'autoSwitch', putty: 'no' },
  { k: 'FtpWorkFromCwd', f: 'ftpWorkFromCwd', t: T.ENUM, e: 'autoSwitch', alias: ['FtpDeleteFromCwd'], putty: 'no' },
  { k: 'FtpAnyCodeForPwd', f: 'ftpAnyCodeForPwd', t: T.BOOL, putty: 'no' },
  { k: 'SslSessionReuse', f: 'sslSessionReuse', t: T.BOOL, putty: 'no' },
  { k: 'TlsCertificateFile', f: 'tlsCertificateFile', t: T.STR, putty: 'no' },
  { k: 'FtpProxyLogonType', f: 'ftpProxyLogonType', t: T.INT, putty: 'no' },
  { k: 'MinTlsVersion', f: 'minTlsVersion', t: T.ENUM, e: 'tlsVersion', putty: 'no' },
  { k: 'MaxTlsVersion', f: 'maxTlsVersion', t: T.ENUM, e: 'tlsVersion', putty: 'no' },
  { k: 'CompleteTlsShutdown', f: 'completeTlsShutdown', t: T.ENUM, e: 'autoSwitch', putty: 'no' },

  { k: 'WebDavLiberalEscaping', f: 'webDavLiberalEscaping', t: T.BOOL, putty: 'no' },
  { k: 'WebDavAuthLegacy', f: 'webDavAuthLegacy', t: T.BOOL, putty: 'no' },
  { k: 'WebDavCrossDomainRedirects', f: 'webDavCrossDomainRedirects', t: T.BOOL, putty: 'no', unsafe: true },
  { k: 'WebDavUnencryptedRedirects', f: 'webDavUnencryptedRedirects', t: T.BOOL, putty: 'no', unsafe: true },

  { k: 'IsWorkspace', f: 'isWorkspace', t: T.BOOL, putty: 'no' },
  { k: 'Link', f: 'link', t: T.STR, putty: 'no' },
  { k: 'NameOverride', f: 'nameOverride', t: T.STR, putty: 'no' },
  { k: 'PuttySettings', f: 'puttySettings', t: T.STR, putty: 'no' },
  { k: 'CustomParam1', f: 'customParam1', t: T.STR, putty: 'no' },
  { k: 'CustomParam2', f: 'customParam2', t: T.STR, putty: 'no' },

  // PuTTY-export-only duplicates of the Kerberos keys plus the window title.
  { k: 'WinTitle', f: 'winTitle', t: T.STR, putty: 'only' },
];

/** Keys DoSave explicitly removes: obsolete or superseded by another key. */
const OBSOLETE_KEYS = ['PingIntervalSec', 'TryGSSKEX', 'UserNameFromEnvironment',
  'GSSAPIServerChoosesUserName', 'GSSAPITrustDNS', 'BuggyMAC', 'AliasGroupList', 'SFTPUtfBug'];

function getField(data, path) {
  if (!path.includes('.')) return data[path];
  const [a, b] = path.split('.');
  return data[a] ? data[a][b] : undefined;
}

function setField(data, path, value) {
  if (!path.includes('.')) { data[path] = value; return; }
  const [a, b] = path.split('.');
  if (!data[a]) data[a] = {};
  data[a][b] = value;
}

/* ------------------------- colour conversion ---------------------- */
//
// WinSCP stores a site colour as a Win32 TColor, which is 0x00BBGGRR — the
// reverse of the `#RRGGBB` this port uses everywhere else. 0 means "no colour",
// which is why an empty string maps to it.

function colorToInt(color) {
  if (!color) return 0;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color).trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xFF, g = (n >> 8) & 0xFF, b = n & 0xFF;
  return (b << 16) | (g << 8) | r;
}

function intToColor(value) {
  const n = Number(value) | 0;
  if (n === 0) return '';
  const r = n & 0xFF, g = (n >> 8) & 0xFF, b = (n >> 16) & 0xFF;
  const hex = (x) => x.toString(16).toUpperCase().padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/* ------------------------- algorithm lists ------------------------ */

/**
 * SetAlgoList. A stored list names only the algorithms the user reordered;
 * anything missing is merged back in from the factory list. Algorithms the
 * factory prioritises above everything the user kept go in front, the rest go
 * behind — and anything below the WARN marker in the factory order stays below
 * it, so a newly added weak algorithm cannot silently become acceptable.
 */
function setAlgoList(defaultList, names, warnAlgo, value) {
  const count = names.length;
  const used = new Set();
  const newList = [];

  const hasWarn = warnAlgo !== null && warnAlgo !== undefined;
  const warnDefaultIndex = hasWarn ? defaultList.indexOf(warnAlgo) : -1;

  let rest = String(value == null ? '' : value);
  while (rest !== '') {
    const p = rest.indexOf(',');
    const algoStr = (p < 0 ? rest : rest.slice(0, p)).trim();
    rest = p < 0 ? '' : rest.slice(p + 1).trim();
    for (const name of names) {
      if (algoStr.toLowerCase() === name.toLowerCase() && !used.has(name) && newList.length < count) {
        newList.push(name);
        used.add(name);
        break;
      }
    }
  }

  if (hasWarn && !used.has(warnAlgo) && newList.length < count) {
    newList.push(warnAlgo);
    used.add(warnAlgo);
  }

  let warnIndex = hasWarn ? newList.indexOf(warnAlgo) : -1;

  let priority = true;
  for (let defaultIndex = 0; defaultIndex < count; defaultIndex++) {
    const defaultAlgo = defaultList[defaultIndex];
    if (!used.has(defaultAlgo) && newList.length < count) {
      let targetIndex;
      if (priority) {
        targetIndex = defaultIndex;
      } else if (hasWarn && defaultIndex < warnDefaultIndex) {
        targetIndex = warnIndex;
      } else {
        targetIndex = newList.length;
      }
      newList.splice(targetIndex, 0, defaultAlgo);
      used.add(defaultAlgo);
      if (hasWarn && targetIndex <= warnIndex) warnIndex++;
    } else {
      priority = false;
    }
  }

  return newList;
}

function algoListToString(list) { return list.join(','); }

/* ================================================================== */
/* load                                                                */
/* ================================================================== */

/**
 * DoLoad. Every option falls back to what the target already holds, which is
 * how "absent means default" works: the caller starts from factory defaults
 * (loadSession) or from the current values (applyRawSettings).
 *
 * `unsafe` marks a source WinSCP does not trust — a URL opened through the
 * registered protocol handler, which is registered with `/Unsafe`. Options that
 * run a command or relax a security check are then dropped **silently**: the
 * C++ comment says warning about them would help an attacker probe. From a
 * trusted source they are applied, and `unsafeSettings` reports that one was
 * actually changed so the login dialog can ask before using them.
 */
function doLoad(data, storage, {
  puttyImport = false, unsafe = false, loadPasswords = true,
} = {}) {
  let unsafeSettings = false;
  let rewritePassword = false;

  /** True when the row must not be read from this source at all. */
  const skipUnsafe = (row) => unsafe && row.unsafe;

  /** Assign, and record that a security-relevant option really changed. */
  const assign = (row, value) => {
    const before = getField(data, row.f);
    setField(data, row.f, value);
    if (row.unsafe && !sameValue(before, getField(data, row.f))) unsafeSettings = true;
  };

  const readWithAliases = (row, reader, current) => {
    // Nested defaults: the innermost (oldest) alias is read first and each
    // outer read falls back to it, so the primary key wins and the closest
    // fallback beats the furthest. An alias is read *without* the enum's
    // textual mapping, matching the inner ReadEnum calls in the C++ — an old
    // key only ever held an integer.
    let value = current;
    if (row.alias) {
      for (let i = row.alias.length - 1; i >= 0; i--) {
        value = reader(row.alias[i], value, true);
      }
    }
    return reader(row.k, value, false);
  };

  // Order matters: HostName may be `user@host`, and setting it clears the user
  // name, so the user name has to be read first.
  data.portNumber = storage.readInteger('PortNumber', data.portNumber);
  data.userName = storage.readString('UserName', data.userName);
  setHostName(data, storage.readString('HostName', data.hostName));

  if (loadPasswords) {
    if (storage.valueExists('PasswordPlain')) {
      data.password = storage.readString('PasswordPlain', data.password);
      rewritePassword = true;
    } else if (storage.valueExists('Password')) {
      data.password = storage.readString('Password', data.password);
    }
  }

  // PingInterval is stored split into minutes and seconds, because PuTTY does.
  let pingIntervalSecs = storage.readInteger('PingIntervalSecs', -1);
  if (pingIntervalSecs < 0) {
    pingIntervalSecs = storage.readInteger('PingIntervalSec', data.pingInterval % 60);
  }
  data.pingInterval = storage.readInteger('PingInterval', Math.trunc(data.pingInterval / 60)) * 60 +
    pingIntervalSecs;
  if (data.pingInterval === 0) data.pingInterval = 30;

  for (const row of OPTIONS) {
    // A PuTTY-export-only key (WinTitle) is written but never read back, in
    // either direction — DoLoad has no counterpart for it.
    if (row.putty === 'only') continue;
    if (row.f === 'hostName' || row.f === 'portNumber' || row.f === 'userName') continue;
    if (row.skipLoadOnPuttyImport && puttyImport) continue;
    if (skipUnsafe(row)) continue;

    const current = getField(data, row.f);
    switch (row.t) {
      case T.STR:
        assign(row, readWithAliases(row, (k, d) => storage.readString(k, d), current));
        break;
      case T.RAW:
        assign(row, readWithAliases(row, (k, d) => storage.readStringRaw(k, d), current));
        break;
      case T.INT:
        assign(row, readWithAliases(row, (k, d) => storage.readInteger(k, d), current));
        break;
      case T.BOOL:
        assign(row, readWithAliases(row, (k, d) => storage.readBool(k, d), current));
        break;
      case T.FLOAT:
        assign(row, readWithAliases(row, (k, d) => storage.readFloat(k, d), current));
        break;
      case T.COLOR:
        assign(row, intToColor(storage.readInteger(row.k, colorToInt(current))));
        break;
      case T.LINES: {
        const text = readWithAliases(row, (k, d) => storage.readString(k, d),
          linesToText(current));
        assign(row, textToLines(text));
        break;
      }
      case T.LIST: {
        const text = readWithAliases(row, (k, d) => storage.readString(k, d),
          algoListToString(current));
        assign(row, setAlgoList(row.def, row.names, row.warn, text));
        break;
      }
      case T.ENUM: {
        const spec = ENUMS[row.e];
        const currentInt = spec.to[current];
        const raw = readWithAliases(row,
          (k, d, isAlias) => storage.readInteger(k, d, isAlias ? undefined : spec.read),
          currentInt === undefined ? spec.to[Object.keys(spec.to)[0]] : currentInt);
        const name = spec.from[raw];
        assign(row, name === undefined ? current : name);
        break;
      }
      default:
        throw new Error(`unknown option type ${row.t}`);
    }
  }

  // Backward compatibility: an old `AliasGroupList` meant a different listing.
  // Inside the same trust check as ListingCommand itself.
  if (!unsafe && !storage.valueExists('ListingCommand') && storage.readBool('AliasGroupList', false)) {
    if (data.listingCommand !== 'ls -gla') unsafeSettings = true;
    data.listingCommand = 'ls -gla';
  }

  // TimeDifference is a TDateTime in days; this port keeps seconds everywhere.
  const days = storage.readFloat('TimeDifference', data.timeDifference / 86400);
  data.timeDifference = Math.round(days * 86400);
  data.timeDifferenceAuto = storage.readBool('TimeDifferenceAuto', data.timeDifference === 0);

  // ProxyDNS is stored rotated so that the old boolean file stays meaningful.
  data.proxyDNS = ENUMS.autoSwitch.from[
    (storage.readInteger('ProxyDNS', (AUTO_SWITCH[data.proxyDNS] + 2) % 3) + 1) % 3] || data.proxyDNS;

  // The proxy command shares one key; which field it lands in depends on the
  // method, and it is raw because it holds `\n` escapes verbatim. It runs a
  // program, so an untrusted source never gets to set it.
  if (!unsafe) {
    const field = data.proxyMethod === 'cmd' ? 'proxyLocalCommand' : 'proxyTelnetCommand';
    const before = data[field];
    data[field] = storage.readStringRaw('ProxyTelnetCommand', before);
    if (data[field] !== before) unsafeSettings = true;
  }

  if (storage.valueExists('ProxyPassword')) {
    data.proxyPassword = storage.readString('ProxyPassword', data.proxyPassword);
  } else if (storage.valueExists('ProxyPasswordEnc')) {
    data.proxyPassword = storage.readString('ProxyPasswordEnc', data.proxyPassword);
  }

  // Bugs are stored inverted (2 - value) because PuTTY's enum runs the other way.
  for (const key of SSH_BUG_KEYS) {
    const field = SSH_BUG_FIELDS[key];
    const current = AUTO_SWITCH[data.sshBugs[field]];
    const stored = storage.readInteger(`Bug${key}`, 2 - current);
    data.sshBugs[field] = ENUMS.autoSwitch.from[2 - stored] || data.sshBugs[field];
  }
  // A pre-bug-enum file said "BuggyMAC" instead.
  if (data.sshBugs.hmac2 === 'auto' && storage.readBool('BuggyMAC', false)) {
    data.sshBugs.hmac2 = 'on';
  }

  // `Special` is read but deliberately never written: if it were, saving a
  // special session under a new name would duplicate the flag onto a site that
  // is not special.
  data.special = storage.readBool('Special', data.special);

  data.puttyProtocol = storage.readString('Protocol', data.puttyProtocol);

  // Importing from PuTTY: its "local proxy to another host" is our tunnel.
  data.tunnel = storage.readBool('Tunnel', data.tunnel);
  if (!data.tunnel && puttyImport && data.proxyMethod === 'system') {
    data.tunnel = true;
    data.tunnelPortNumber = data.proxyPort;
    data.tunnelUserName = data.proxyUsername;
    data.tunnelHostName = data.proxyHost;
    data.tunnelPassword = data.proxyPassword;
    defaultProxy(data);
  } else {
    data.tunnelPortNumber = storage.readInteger('TunnelPortNumber', data.tunnelPortNumber);
    data.tunnelUserName = storage.readString('TunnelUserName', data.tunnelUserName);
    setTunnelHostName(data, storage.readString('TunnelHostName', data.tunnelHostName));
    if (loadPasswords) {
      if (storage.valueExists('TunnelPasswordPlain')) {
        data.tunnelPassword = storage.readString('TunnelPasswordPlain', data.tunnelPassword);
        rewritePassword = true;
      } else if (storage.valueExists('TunnelPassword')) {
        data.tunnelPassword = storage.readString('TunnelPassword', data.tunnelPassword);
      }
    }
  }

  // The tunnel passphrase is loaded even in scripting, because unlike the main
  // passphrase there is no switch that could supply it instead.
  if (loadPasswords) {
    if (storage.valueExists('TunnelPassphrasePlain')) {
      data.tunnelPassphrase = storage.readString('TunnelPassphrasePlain', data.tunnelPassphrase);
      rewritePassword = true;
    } else if (storage.valueExists('TunnelPassphrase')) {
      data.tunnelPassphrase = storage.readString('TunnelPassphrase', data.tunnelPassphrase);
    }
  }

  if (storage.valueExists('EncryptKeyPlain')) {
    data.encryptKey = storage.readString('EncryptKeyPlain', data.encryptKey);
    rewritePassword = true;
  } else if (storage.valueExists('EncryptKey')) {
    data.encryptKey = storage.readString('EncryptKey', data.encryptKey);
  }

  return { unsafeSettings, rewritePassword };
}

/** TSessionData::Load — a stored session, starting from factory defaults. */
function loadSession(values, { name = '', puttyImport = false, loadPasswords = true } = {}) {
  const data = defaultSessionData(name);
  const storage = values instanceof KeyValueStorage
    ? values
    : new KeyValueStorage(values, { mungeValues: !puttyImport });
  const info = doLoad(data, storage, { puttyImport, unsafe: false, loadPasswords });
  data.modified = false;
  data.source = SOURCE.STORED;
  return { data, ...info };
}

/**
 * ApplyRawSettings — the `-rawsettings`/`x-` path. Unlike a load, this starts
 * from what the session already holds, so a raw setting overrides one field
 * without resetting the rest.
 */
function applyRawSettings(data, lines, { unsafe = false, loadName = false } = {}) {
  const storage = Array.isArray(lines) ? storageFromLines(lines) : lines;
  const info = doLoad(data, storage, { unsafe });
  let parsedInfo = 0;
  if (loadName && storage.valueExists(SESSION_NAME_SETTINGS_NAME)) {
    data.name = storage.readString(SESSION_NAME_SETTINGS_NAME, '');
  }
  if (info.unsafeSettings) parsedInfo |= PI.UNSAFE_SETTINGS;
  return { parsedInfo, unsafeSettings: info.unsafeSettings };
}

/* ================================================================== */
/* save                                                                */
/* ================================================================== */

/**
 * DoSave. The one rule that matters: when a baseline is given, an option equal
 * to the baseline is *deleted* rather than written. That is what keeps a
 * WinSCP.ini to the handful of lines a site actually changed, and it is also
 * what makes generateSessionUrl's `x-` parameters short enough to be a URL.
 * With no baseline (`defaultData === null`) every option is written, which is
 * how the Advanced dialog lists them all.
 */
function doSave(data, storage, { defaultData = null, puttyExport = false, savePasswords = true } = {}) {
  const write = (key, type, value, defValue, row) => {
    if (defaultData !== null && sameValue(value, defValue)) {
      storage.deleteValue(key);
      return;
    }
    switch (type) {
      case T.STR:
        // PuTTY reads its own store unmunged, so the few keys it shares with
        // us go out raw. (WinSCP additionally expands a relative key-file path
        // here, because PuTTY runs from its own directory; there is no such
        // working directory to resolve against in this process, so the path is
        // written as given.)
        if (row && row.puttyRaw && puttyExport) storage.writeStringRaw(key, value);
        else storage.writeString(key, value);
        break;
      case T.RAW: storage.writeStringRaw(key, value); break;
      case T.INT: storage.writeInteger(key, value); break;
      case T.BOOL: storage.writeBool(key, value); break;
      case T.FLOAT: storage.writeFloat(key, value); break;
      default: storage.writeString(key, value); break;
    }
  };

  // PingInterval, split the way PuTTY stores it. Exporting a session with
  // pings off writes zeroes rather than deleting, because PuTTY has no "off".
  if (data.pingType === 'off' && puttyExport) {
    storage.writeInteger('PingInterval', 0);
    storage.writeInteger('PingIntervalSecs', 0);
  } else {
    const mins = Math.trunc(data.pingInterval / 60);
    const secs = data.pingInterval % 60;
    const dMins = defaultData ? Math.trunc(defaultData.pingInterval / 60) : null;
    const dSecs = defaultData ? defaultData.pingInterval % 60 : null;
    write('PingInterval', T.INT, mins, dMins);
    write('PingIntervalSecs', T.INT, secs, dSecs);
  }
  storage.deleteValue('PingIntervalSec');

  for (const row of OPTIONS) {
    if (puttyExport && row.putty === 'no') continue;
    if (!puttyExport && row.putty === 'only') continue;

    const value = getField(data, row.f);
    const defValue = defaultData ? getField(defaultData, row.f) : undefined;

    switch (row.t) {
      case T.STR: case T.RAW: case T.INT: case T.BOOL: case T.FLOAT:
        write(row.k, row.t, value, defValue, row);
        break;
      case T.COLOR:
        write(row.k, T.INT, colorToInt(value), defaultData ? colorToInt(defValue) : undefined);
        break;
      case T.LINES:
        write(row.k, T.STR, linesToText(value), defaultData ? linesToText(defValue) : undefined);
        break;
      case T.LIST:
        write(row.k, T.STR, algoListToString(value),
          defaultData ? algoListToString(defValue) : undefined);
        break;
      case T.ENUM: {
        const spec = ENUMS[row.e];
        write(row.k, T.INT, spec.to[value], defaultData ? spec.to[defValue] : undefined);
        break;
      }
      default: throw new Error(`unknown option type ${row.t}`);
    }
  }

  // TimeDifference. When FTP detects the offset itself the stored value is
  // meaningless, and it has to be deleted rather than skipped because the
  // default for TimeDifferenceAuto is derived from it.
  if (data.timeDifferenceAuto && data.protocol === 'ftp') {
    storage.deleteValue('TimeDifference');
  } else {
    write('TimeDifference', T.FLOAT, data.timeDifference / 86400,
      defaultData ? defaultData.timeDifference / 86400 : undefined);
  }

  // ProxyDNS, rotated back the way it is stored.
  write('ProxyDNS', T.INT, (AUTO_SWITCH[data.proxyDNS] + 2) % 3,
    defaultData ? (AUTO_SWITCH[defaultData.proxyDNS] + 2) % 3 : undefined);

  // The proxy command, in whichever field the method puts it.
  if (data.proxyMethod === 'cmd') {
    write('ProxyTelnetCommand', T.RAW, data.proxyLocalCommand,
      defaultData ? defaultData.proxyLocalCommand : undefined);
  } else {
    write('ProxyTelnetCommand', T.RAW, data.proxyTelnetCommand,
      defaultData ? defaultData.proxyTelnetCommand : undefined);
  }

  for (const key of SSH_BUG_KEYS) {
    const field = SSH_BUG_FIELDS[key];
    write(`Bug${key}`, T.INT, 2 - AUTO_SWITCH[data.sshBugs[field]],
      defaultData ? 2 - AUTO_SWITCH[defaultData.sshBugs[field]] : undefined);
  }

  if (puttyExport) {
    // The Kerberos settings are written again under the names the Quest and
    // official PuTTY builds use, so an export works whichever one opens it.
    write('AuthSSPI', T.BOOL, data.authGSSAPI, defaultData ? defaultData.authGSSAPI : undefined);
    write('SSPIFwdTGT', T.BOOL, data.gssapiFwdTGT, defaultData ? defaultData.gssapiFwdTGT : undefined);
    write('KerbPrincipal', T.STR, data.logicalHostName, defaultData ? defaultData.logicalHostName : undefined);
    write('GssapiFwd', T.BOOL, data.gssapiFwdTGT, defaultData ? defaultData.gssapiFwdTGT : undefined);
    write('Protocol', T.STR, normalizedPuttyProtocol(data),
      defaultData ? normalizedPuttyProtocol(defaultData) : undefined);
  }

  for (const key of OBSOLETE_KEYS) storage.deleteValue(key);

  if (savePasswords) savePasswordsTo(data, storage, { puttyExport, saveAll: defaultData === null });

  return storage;
}

/**
 * SavePasswords. `PasswordPlain` and `Password` are mutually exclusive: writing
 * one always deletes the other, so a file can never carry two versions of the
 * same secret. This port hands the value to config.js to protect, so what is
 * written here is the plain form under the `*Plain` names.
 */
function savePasswordsTo(data, storage, { puttyExport = false, saveAll = false } = {}) {
  if (!puttyExport && (data.password || saveAll)) {
    storage.writeString('PasswordPlain', data.password);
    storage.deleteValue('Password');
  } else {
    storage.deleteValue('Password');
    storage.deleteValue('PasswordPlain');
  }

  if (puttyExport) {
    // PuTTY has no protected form, so an export is unencrypted by definition.
    storage.writeString('ProxyPassword', data.proxyPassword);
    return;
  }

  const pair = (plainName, encName, value) => {
    if (value || saveAll) storage.writeString(plainName, value);
    else storage.deleteValue(plainName);
    storage.deleteValue(encName);
  };
  pair('ProxyPassword', 'ProxyPasswordEnc', data.proxyPassword);
  pair('TunnelPasswordPlain', 'TunnelPassword', data.tunnelPassword);
  pair('TunnelPassphrasePlain', 'TunnelPassphrase', data.tunnelPassphrase);
  pair('EncryptKeyPlain', 'EncryptKey', data.encryptKey);
}

/** TSessionData::Save — the `{ Key: 'value' }` an INI section would hold. */
function saveSession(data, { defaultData = defaultSessionData(), puttyExport = false, savePasswords = true } = {}) {
  const storage = new KeyValueStorage({}, { mungeValues: !puttyExport });
  doSave(data, storage, { defaultData, puttyExport, savePasswords });
  return storage.values;
}

/**
 * SaveToOptions — the same thing as `Name=Value` lines, which is the format the
 * Advanced > Raw settings dialog edits and `-rawsettings` carries.
 */
function saveToOptions(data, { defaultData = defaultSessionData(), saveName = false, puttyExport = false } = {}) {
  const storage = new KeyValueStorage({}, { mungeValues: true });
  if (saveName) storage.writeString(SESSION_NAME_SETTINGS_NAME, data.name);
  doSave(data, storage, { defaultData, puttyExport, savePasswords: true });
  return storage.toLines();
}

/** GetAllOptionNames — every key a raw setting may use, for the dialog's list. */
function allOptionNames({ puttyExport = false } = {}) {
  const lines = saveToOptions(defaultSessionData(), { defaultData: null, puttyExport });
  return lines.map((l) => l.slice(0, l.indexOf('=')));
}

function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => sameValue(a[k], b[k]));
  }
  return a === b;
}

function linesToText(lines) {
  if (Array.isArray(lines)) return lines.join('\r\n');
  return String(lines == null ? '' : lines);
}

function textToLines(text) {
  const s = String(text == null ? '' : text);
  if (s === '') return [];
  const parts = s.split(/\r\n|\n|\r/);
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/* ================================================================== */
/* property semantics that are not plain assignment                    */
/* ================================================================== */

/**
 * SetHostName. A host name of `user@host` splits, because PuTTY stores it that
 * way and pasting one into the login dialog should work.
 */
function setHostName(data, value) {
  let v = String(value == null ? '' : value);
  const p = v.lastIndexOf('@');
  if (p > 0) {
    data.userName = v.slice(0, p);
    v = v.slice(p + 1);
  }
  data.hostName = v;
  return data;
}

/** The tunnel host name splits the same way. */
function setTunnelHostName(data, value) {
  let v = String(value == null ? '' : value);
  const p = v.lastIndexOf('@');
  if (p > 0) {
    data.tunnelUserName = v.slice(0, p);
    v = v.slice(p + 1);
  }
  data.tunnelHostName = v;
  return data;
}

function defaultProxy(data) {
  data.proxyMethod = 'none';
  data.proxyHost = 'proxy';
  data.proxyPort = PROXY_PORT;
  data.proxyUsername = '';
  data.proxyPassword = '';
}

/** DetectReturnVar / DefaultShell: an empty string means "let the shell decide". */
function detectReturnVar(data) { return data.returnVar === ''; }
function setDetectReturnVar(data, value) {
  if (value !== detectReturnVar(data)) data.returnVar = value ? '' : '$?';
}
function isDefaultShell(data) { return data.shell === ''; }
function setDefaultShell(data, value) {
  if (value !== isDefaultShell(data)) data.shell = value ? '' : '/bin/bash';
}

function normalizedPuttyProtocol(data) { return data.puttyProtocol || 'ssh'; }

/* ================================================================== */
/* identity, comparison and naming                                     */
/* ================================================================== */

function isSshProtocol(protocol) {
  return protocol === 'sftp' || protocol === 'sftpOnly' || protocol === 'scp';
}

/** fsSFTPonly and fsSFTP are the same site for matching purposes. */
function normalizeProtocol(protocol) { return protocol === 'sftpOnly' ? 'sftp' : protocol; }

function defaultPort(protocol, ftps = 'none') {
  switch (protocol) {
    case 'ftp': return ftps === 'implicit' ? FTPS_IMPLICIT_PORT : FTP_PORT;
    case 'webdav':
    case 's3': return ftps === 'none' ? HTTP_PORT : HTTPS_PORT;
    default: return isSshProtocol(protocol) ? SSH_PORT : -1;
  }
}

function getDefaultPort(data) { return defaultPort(data.protocol, data.ftps); }

function usesSsh(data) { return isSshProtocol(data.protocol); }

function isSecure(data) {
  if (isSshProtocol(data.protocol)) return true;
  return data.ftps !== 'none';
}

function canLogin(data) { return data.hostName !== ''; }
function isLocalBrowser(data) {
  return data.localDirectory !== '' && data.otherLocalDirectory !== '';
}
function canOpen(data) { return canLogin(data) || isLocalBrowser(data); }

function isHidden(name) { return String(name).startsWith(HIDDEN_PREFIX); }

function nameWithoutHiddenPrefix(name) {
  return isHidden(name) ? String(name).slice(HIDDEN_PREFIX.length) : String(name);
}

function hasSessionName(data) {
  const n = nameWithoutHiddenPrefix(data.name || '');
  return n !== '' && data.name !== DEFAULT_SETTINGS_NAME;
}

/** MakeValidName / ValidateName: a `/` is the folder separator, so it is banned. */
function makeValidName(name) { return String(name).split('/').join('\\'); }

function validateName(name) {
  if (String(name).includes('/')) {
    throw new Error(`Invalid name '${name}'. Name cannot contain '/'.`);
  }
}

/** ValidatePath is a no-op in WinSCP; kept so callers read the same. */
function validatePath() { /* noop, as in the C++ */ }

function extractLocalName(name) {
  const p = String(name).lastIndexOf('/');
  return p < 0 ? String(name) : String(name).slice(p + 1);
}

function extractFolderName(name) {
  const p = String(name).lastIndexOf('/');
  return p < 0 ? '' : String(name).slice(0, p);
}

function composePath(path, name) {
  const p = String(path);
  return (p === '' || p.endsWith('/') ? p : p + '/') + name;
}

/** ExtractShortName for a local path, used by the local-browser session name. */
function extractShortName(dir) {
  const s = String(dir).replace(/[\\/]+$/, '');
  const p = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return p < 0 ? s : s.slice(p + 1);
}

function defaultSessionName(data) {
  let result;
  if (isLocalBrowser(data)) {
    result = extractShortName(data.localDirectory) + TITLE_SEPARATOR +
      extractShortName(data.otherLocalDirectory);
  } else if (data.hostName !== '' && data.userName !== '') {
    result = `${data.userName}@${data.hostName}`;
  } else if (data.hostName !== '') {
    result = data.hostName;
  } else {
    result = 'session';
  }
  return makeValidName(result);
}

function sessionName(data) {
  return hasSessionName(data) ? nameWithoutHiddenPrefix(data.name) : defaultSessionName(data);
}

function localName(data) {
  return hasSessionName(data) ? extractLocalName(data.name) : defaultSessionName(data);
}

function folderName(data) {
  return (hasSessionName(data) || data.isWorkspace) ? extractFolderName(data.name) : '';
}

function formatSiteKey(hostName, portNumber) { return `${hostName}:${portNumber}`; }
function siteKey(data) { return formatSiteKey(data.hostName, data.portNumber); }

function sessionKey(data) {
  let result = `${data.userName}@${data.hostName}`;
  if (data.portNumber !== getDefaultPort(data)) result += `:${data.portNumber}`;
  return result;
}

/** InternalStorageKey — the INI subkey a session is stored under. */
function internalStorageKey(data) {
  return data.name === '' ? sessionKey(data) : data.name;
}

function isInFolderOrWorkspace(data, folder) {
  const f = String(folder);
  const prefix = f === '' || f.endsWith('/') ? f : f + '/';
  return String(data.name).toLowerCase().startsWith(prefix.toLowerCase());
}

function infoTip(data) {
  const proto = FS_PROTOCOL_NAMES[data.protocol] || data.protocol;
  if (usesSsh(data)) {
    return `Host name: ${data.hostName}\nUser name: ${data.userName}\n` +
      `Private key file: ${data.publicKeyFile === '' ? 'No' : 'Yes'}\nFile transfer protocol: ${proto}`;
  }
  return `Host name: ${data.hostName}\nUser name: ${data.userName}\nFile transfer protocol: ${proto}`;
}

/* --------------------------- comparison --------------------------- */

/** The core properties a site is identified by (BASE_PROPERTIES). */
const BASE_PROPERTIES = ['hostName', 'portNumber', 'userName', 'password', 'publicKeyFile',
  'detachedCertificate', 'passphrase', 'protocol', 'ftps', 'localDirectory',
  'otherLocalDirectory', 'remoteDirectory', 'requireDirectories', 'color',
  'synchronizeBrowsing', 'note'];

/** META_PROPERTIES. */
const META_PROPERTIES = ['isWorkspace', 'link', 'nameOverride'];

/**
 * ADVANCED_PROPERTIES — everything else that participates in equality. Derived
 * from the option table so that adding an option cannot leave the comparison
 * behind, plus the properties DoSave handles specially.
 */
const ADVANCED_PROPERTIES = (() => {
  const skip = new Set([...BASE_PROPERTIES, ...META_PROPERTIES,
    'name', 'source', 'saveOnly', 'overrideCachedHostKey', 'modified']);
  const out = [];
  for (const row of OPTIONS) if (!skip.has(row.f)) out.push(row.f);
  for (const f of ['newPassword', 'changePassword', 'pingInterval', 'timeDifference',
    'timeDifferenceAuto', 'proxyPassword', 'proxyDNS', 'proxyTelnetCommand',
    'proxyLocalCommand', 'sshBugs', 'tunnelPassword', 'tunnelPassphrase',
    'tunnelPortFwd', 'encryptKey', 'selected', 'special']) {
    if (!skip.has(f) && !out.includes(f)) out.push(f);
  }
  return out;
})();

/**
 * IsSame. With `differentProperties` it collects every difference instead of
 * stopping at the first, which is what the "compare sites" surfaces need.
 */
function isSame(a, b, { advancedOnly = false, differentProperties = null } = {}) {
  let result = true;
  const props = advancedOnly
    ? ADVANCED_PROPERTIES
    : [...BASE_PROPERTIES, ...META_PROPERTIES, ...ADVANCED_PROPERTIES];
  for (const p of props) {
    if (!sameValue(getField(a, p), getField(b, p))) {
      result = false;
      if (differentProperties === null) return false;
      differentProperties.push(p);
    }
  }
  return result;
}

/** IsSameSite: protocol, host, port and user — what makes it the same server. */
function isSameSite(a, b) {
  return normalizeProtocol(a.protocol) === normalizeProtocol(b.protocol) &&
    a.hostName === b.hostName && a.portNumber === b.portNumber && a.userName === b.userName;
}

/* --------------------------- copying ------------------------------ */

function copyData(target, source) {
  const props = ['name', ...BASE_PROPERTIES, ...META_PROPERTIES, ...ADVANCED_PROPERTIES];
  for (const p of props) setField(target, p, deepClone(getField(source, p)));
  target.overrideCachedHostKey = source.overrideCachedHostKey;
  target.modified = source.modified;
  target.saveOnly = source.saveOnly;
  return target;
}

function assignSessionData(target, source) {
  copyData(target, source);
  target.source = source.source;
  return target;
}

function copyDirectoriesStateData(target, source) {
  target.remoteDirectory = source.remoteDirectory;
  target.localDirectory = source.localDirectory;
  target.otherLocalDirectory = source.otherLocalDirectory;
  target.synchronizeBrowsing = source.synchronizeBrowsing;
  return target;
}

function hasStateData(data) {
  return data.remoteDirectory !== '' || data.localDirectory !== '' ||
    data.otherLocalDirectory !== '' || colorToInt(data.color) !== 0;
}

function copyStateData(target, source) {
  copyDirectoriesStateData(target, source);
  target.color = source.color;
  return target;
}

function copyNonCoreData(target, source) {
  copyStateData(target, source);
  target.updateDirectories = source.updateDirectories;
  target.note = source.note;
  return target;
}

/* ================================================================== */
/* passwords                                                           */
/* ================================================================== */

function hasPassword(data) { return data.password !== ''; }

function hasAnySessionPassword(data) {
  return hasPassword(data) || data.tunnelPassword !== '' || data.newPassword !== '';
}

function hasAnyPassword(data) {
  return hasAnySessionPassword(data) || data.proxyPassword !== '' ||
    data.encryptKey !== '' || data.passphrase !== '' || data.tunnelPassphrase !== '';
}

function clearSessionPasswords(data) {
  data.password = '';
  data.newPassword = '';
  data.tunnelPassword = '';
  return data;
}

/** MaskPasswords: every secret becomes `***`, never a truncated real value. */
function maskPasswords(data) {
  for (const f of ['password', 'newPassword', 'proxyPassword', 'tunnelPassword',
    'tunnelPassphrase', 'encryptKey', 'passphrase']) {
    if (data[f] !== '') data[f] = PASSWORD_MASK;
  }
  return data;
}

/**
 * IsSensitiveOption — whether a command-line switch's value must never be
 * logged. `privatekey` counts only when the value is key material rather than a
 * file name; without PuTTY's in-memory key store here, a value that looks like
 * a PEM/PuTTY key body is treated as sensitive and a path is not.
 */
function isSensitiveOption(option, value) {
  const o = String(option).toLowerCase();
  if (o === PASSPHRASE_OPTION || o === 'password' || o === 'newpassword') return true;
  if (o === 'privatekey') {
    return /-----BEGIN |^PuTTY-User-Key-File-/m.test(String(value == null ? '' : value));
  }
  return false;
}

/** IsOptionWithParameters — only `-rawsettings` consumes following parameters. */
function isOptionWithParameters(option) {
  return String(option).toLowerCase() === RAW_SETTINGS_OPTION;
}

/**
 * MaskPasswordInOptionParameter — a `-rawsettings` parameter can itself carry a
 * secret, so the key is inspected and the value replaced before logging.
 */
function maskPasswordInOptionParameter(option, param) {
  if (String(option).toLowerCase() !== RAW_SETTINGS_OPTION) return { masked: false, param };
  const p = String(param).indexOf('=');
  if (p < 0) return { masked: false, param };
  const key = String(param).slice(0, p);
  const secret = ['proxypassword', 'proxypasswordenc', 'tunnelpassword', 'tunnelpasswordplain',
    'tunnelpassphrase', 'tunnelpassphraseplain', 'encryptkey', 'encryptkeyplain'];
  if (secret.includes(key.toLowerCase())) {
    return { masked: true, param: `${key}=${PASSWORD_MASK}` };
  }
  return { masked: false, param };
}

/* ================================================================== */
/* IPv6 and URL encoding                                               */
/* ================================================================== */

function hasIP6LiteralBrackets(hostName) {
  const h = String(hostName);
  return h.length >= 2 && h[0] === '[' && h[h.length - 1] === ']';
}

function stripIP6LiteralBrackets(hostName) {
  const h = String(hostName);
  return hasIP6LiteralBrackets(h) ? h.slice(1, -1) : h;
}

function isHex(c) { return /[0-9a-fA-F]/.test(c); }

/**
 * IsIPv6Literal. Hex digits and colons only, at least two colons, and anything
 * from a `%` (a zone index) onwards is accepted without inspection.
 */
function isIPv6Literal(hostName) {
  let buf = String(hostName);
  if (hasIP6LiteralBrackets(buf)) buf = stripIP6LiteralBrackets(buf);
  let colons = 0;
  let result = true;
  for (let i = 0; result && i < buf.length; i++) {
    const c = buf[i];
    if (c === '%') break;
    else if (c === ':') colons++;
    else result = isHex(c);
  }
  return result && colons >= 2;
}

function escapeIPv6Literal(ip) {
  return hasIP6LiteralBrackets(ip) ? String(ip) : `[${ip}]`;
}

/** DoEncodeUrl: letters, digits, `_ - . *` survive; everything else is UTF-8 %XX. */
function doEncodeUrl(s, doNotEncode = '') {
  let out = '';
  for (const ch of String(s)) {
    if (/[A-Za-z0-9]/.test(ch) || ch === '_' || ch === '-' || ch === '.' || ch === '*' ||
        doNotEncode.includes(ch)) {
      out += ch;
    } else {
      for (const b of Buffer.from(ch, 'utf8')) {
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

function encodeUrlString(s) { return doEncodeUrl(s, ''); }
function encodeUrlPath(s) { return doEncodeUrl(s, '/'); }

/** DecodeUrlChars: `+` is a space, and a run of `%XX` is decoded as UTF-8. */
function decodeUrlChars(s) {
  const str = String(s);
  let out = '';
  let i = 0;
  while (i < str.length) {
    if (str[i] === '+') { out += ' '; i++; continue; }
    if (str[i] === '%' && i + 2 < str.length && isHex(str[i + 1]) && isHex(str[i + 2])) {
      const bytes = [];
      while (i + 2 < str.length && str[i] === '%' && isHex(str[i + 1]) && isHex(str[i + 2])) {
        bytes.push(parseInt(str.substr(i + 1, 2), 16));
        i += 3;
      }
      out += Buffer.from(bytes).toString('utf8');
      continue;
    }
    out += str[i];
    i++;
  }
  return out;
}

/* ================================================================== */
/* URL generation                                                      */
/* ================================================================== */

function protocolUrl(data, httpForWebDAV = false) {
  let url;
  switch (data.protocol) {
    case 'scp': url = 'scp'; break;
    case 'ftp':
      if (data.ftps === 'implicit') url = 'ftps';
      else if (data.ftps === 'explicitTls' || data.ftps === 'explicitSsl') url = 'ftpes';
      else url = 'ftp';
      break;
    case 'webdav':
      if (httpForWebDAV) url = data.ftps === 'implicit' ? 'https' : 'http';
      else url = data.ftps === 'implicit' ? 'davs' : 'dav';
      break;
    case 's3': url = data.ftps === 'implicit' ? 's3' : 's3plain'; break;
    default: url = 'sftp'; break;   // fsSFTP, fsSFTPonly and the fallback
  }
  return url + '://';
}

/** Base64ToUrlSafe: strip padding, `+`→`-`, `/`→`_`. */
function base64ToUrlSafe(s) {
  return String(s).replace(/=+$/, '').split('+').join('-').split('/').join('_');
}

/** MD5ToUrlSafe: the colons of an MD5 fingerprint become dashes. */
function md5ToUrlSafe(s) { return String(s).split(':').join(NORMALIZED_FINGERPRINT_SEPARATOR); }

/**
 * NormalizeFingerprint. A stored SSH host key looks like
 * `ssh-ed25519 255 SHA256:abc…`; the URL form is `ssh-ed25519-SHA256-abc…`, so
 * the algorithm name is split off and the fingerprint made URL-safe. A TLS
 * certificate fingerprint has no algorithm prefix and only loses its colons.
 */
function normalizeFingerprint(fingerprint) {
  let fp = String(fingerprint);
  for (const name of HOSTKEY_ALG_IDS) {
    if (fp.startsWith(name + ' ')) {
      const rest = fp.slice(name.length + 1);
      const space = rest.indexOf(' ');
      const bits = space < 0 ? '' : rest.slice(0, space);
      if (/^\d+$/.test(bits)) {
        return { keyName: name, fingerprint: md5ToUrlSafe(base64ToUrlSafe(rest.slice(space + 1))) };
      }
    } else if (fp.startsWith(name + NORMALIZED_FINGERPRINT_SEPARATOR)) {
      return { keyName: name, fingerprint: fp.slice(name.length + 1) };
    }
  }
  return { keyName: '', fingerprint: fp };
}

/**
 * GetRawSettingsForUrl. The options a URL has to carry as `x-` parameters are
 * everything that is neither expressible in the URL itself (protocol, host,
 * port, user, password, host key) nor per-machine state (directories, colour,
 * note), measured against the factory defaults.
 */
function getRawSettingsForUrl(data) {
  const factory = defaultSessionData();
  const s = cloneSessionData(data);
  s.protocol = factory.protocol;
  s.hostName = factory.hostName;
  s.portNumber = factory.portNumber;
  s.userName = factory.userName;
  s.password = factory.password;
  s.ftps = factory.ftps;
  s.hostKey = factory.hostKey;
  copyNonCoreData(s, factory);
  // SaveToOptions cannot decide this itself: without a host and user name it
  // cannot work out what the default session name would have been.
  const saveName = hasSessionName(data) && data.name !== defaultSessionName(data);
  if (saveName) s.name = data.name;
  return saveToOptions(s, { defaultData: factory, saveName, puttyExport: false });
}

function hasRawSettingsForUrl(data) { return getRawSettingsForUrl(data).length > 0; }

/**
 * GenerateSessionUrl. The password is only included when SUF.PASSWORD is asked
 * for; callers that display a URL pass sufSession without it, or mask the data
 * first. Note that the parameters hang off the *user info*, before the `@` —
 * that is WinSCP's own extension to the URL syntax and it is what lets a
 * fingerprint and raw settings ride along.
 */
function generateSessionUrl(data, flags = SUF.SESSION) {
  let url = '';
  if (flags & SUF.SPECIFIC) url += WINSCP_PROTOCOL_PREFIX;
  url += protocolUrl(data, (flags & SUF.HTTP_FOR_WEBDAV) !== 0);

  if ((flags & SUF.USERNAME) && data.userName !== '') {
    url += encodeUrlString(data.userName);

    if ((flags & SUF.PASSWORD) && data.password !== '') {
      url += ':' + encodeUrlString(data.password);
    }

    if ((flags & SUF.HOSTKEY) && data.hostKey !== '') {
      const { keyName, fingerprint } = normalizeFingerprint(data.hostKey);
      let s = fingerprint;
      if (keyName !== '') s = keyName + NORMALIZED_FINGERPRINT_SEPARATOR + s;
      s = md5ToUrlSafe(base64ToUrlSafe(s));
      url += URL_PARAM_SEPARATOR + URL_HOSTKEY_PARAM_NAME + URL_PARAM_VALUE_SEPARATOR +
        encodeUrlString(s);
    }

    if (flags & SUF.RAWSETTINGS) {
      for (const line of getRawSettingsForUrl(data)) {
        const p = line.indexOf('=');
        const name = line.slice(0, p);
        const value = line.slice(p + 1);
        url += URL_PARAM_SEPARATOR + URL_RAW_SETTINGS_PARAM_PREFIX +
          encodeUrlString(name.toLowerCase()) + URL_PARAM_VALUE_SEPARATOR +
          encodeUrlString(value);
      }
    }

    url += '@';
  }

  const host = data.hostName;
  url += isIPv6Literal(host) ? escapeIPv6Literal(host) : encodeUrlString(host);

  if (data.portNumber !== getDefaultPort(data)) url += ':' + data.portNumber;
  url += '/';
  return url;
}

/**
 * GenerateOpenCommandArgs — the scripting `open` line for this site. Everything
 * the URL cannot say becomes a switch, and whatever is left over becomes
 * `-rawsettings`.
 */
function generateOpenCommandArgs(data) {
  const factory = defaultSessionData();
  const s = cloneSessionData(data);

  let result = generateSessionUrl(s, SUF.OPEN);

  const aUsesSsh = usesSsh(s);
  // SFTP-only is not something a URL scheme can express, so it stays in the
  // raw settings rather than being reset with the rest of the protocol.
  if (s.protocol !== 'sftpOnly') s.protocol = factory.protocol;
  s.hostName = factory.hostName;
  s.portNumber = factory.portNumber;
  s.userName = factory.userName;
  s.password = factory.password;
  copyNonCoreData(s, factory);
  s.ftps = factory.ftps;

  const addSwitch = (name, value) => {
    if (value === undefined) return ` -${name}`;
    if (typeof value === 'number') return ` -${name}=${value}`;
    return ` -${name}="${escapeParam(value)}"`;
  };

  if (s.hostKey !== factory.hostKey) {
    result += addSwitch(aUsesSsh ? 'hostkey' : 'certificate', s.hostKey);
    s.hostKey = factory.hostKey;
  }
  if (s.publicKeyFile !== factory.publicKeyFile) {
    result += addSwitch('privatekey', s.publicKeyFile);
    s.publicKeyFile = factory.publicKeyFile;
  }
  if (s.tlsCertificateFile !== factory.tlsCertificateFile) {
    result += addSwitch('clientcert', s.tlsCertificateFile);
    s.tlsCertificateFile = factory.tlsCertificateFile;
  }
  if (s.passphrase !== factory.passphrase) {
    result += addSwitch(PASSPHRASE_OPTION, s.passphrase);
    s.passphrase = factory.passphrase;
  }
  if (s.ftpPasvMode !== factory.ftpPasvMode) {
    result += addSwitch('passive', s.ftpPasvMode ? 1 : 0);
    s.ftpPasvMode = factory.ftpPasvMode;
  }
  if (s.timeout !== factory.timeout) {
    result += addSwitch('timeout', s.timeout);
    s.timeout = factory.timeout;
  }

  const rawSettings = saveToOptions(s, { defaultData: factory, saveName: false });
  if (rawSettings.length > 0) {
    result += addSwitch(RAW_SETTINGS_OPTION);
    result += stringsToParams(rawSettings);
  }
  return result;
}

/* ================================================================== */
/* URL parsing                                                         */
/* ================================================================== */

function isDomainOrSubdomain(fullDomain, domain) {
  const f = String(fullDomain).toLowerCase();
  const d = String(domain).toLowerCase();
  return f === d || f.endsWith('.' + d);
}

function doIsProtocolUrl(url, protocol) {
  return String(url).slice(0, protocol.length + 1).toLowerCase() === (protocol + ':').toLowerCase()
    ? protocol.length + 1 : 0;
}

/** `winscp-sftp://` is accepted wherever `sftp://` is — that is the handler. */
function isProtocolUrl(url, protocol) {
  return doIsProtocolUrl(url, protocol) || doIsProtocolUrl(url, WINSCP_PROTOCOL_PREFIX + protocol);
}

/** CutToChar over a plain string. */
function cutToChar(str, ch, trim) {
  const p = str.indexOf(ch);
  let head, tail;
  if (p >= 0) { head = str.slice(0, p); tail = str.slice(p + 1); }
  else { head = str; tail = ''; }
  if (trim) { head = head.replace(/\s+$/, ''); tail = tail.replace(/^\s+/, ''); }
  return { head, tail };
}

/**
 * TSessionData::ParseUrl.
 *
 * Handles, in this order: the protocol prefix (including WinSCP's own and the
 * `http`/`https` aliases that mean WebDAV or S3 depending on context), a stored
 * site name used as the whole URL or as its first segment, the `user:password@`
 * credentials, an IPv6 literal in brackets, the port, the `;fingerprint=` and
 * `;x-<setting>=` parameters, the remote path and a trailing file name, and the
 * `;save=` session parameter.
 *
 * `maskedUrl` is the same URL with the password replaced by `***` — it exists
 * precisely so that a URL can be logged, and it is built alongside the real one
 * rather than by re-scanning the result.
 */
function parseUrl(url, {
  data = null, options = null, storedSessions = null, flags = 0, wantFileName = false,
} = {}) {
  const target = data || defaultSessionData();
  let aUrl = String(url == null ? '' : url);
  let parsedInfo = 0;
  let fileName = '';
  let maskedUrl = '';

  let protocolDefined = true;
  let portNumberDefined = false;
  let aProtocol = null;
  let defaultProtocolPort = 0;
  let aFtps = 'none';
  let protocolLen = 0;

  const httpForWebdav = !(flags & PUF.PREFER_PROTOCOL) || target.protocol !== 's3';

  const tryProtocol = (name) => { protocolLen = isProtocolUrl(aUrl, name); return protocolLen > 0; };

  if (tryProtocol('scp')) {
    aProtocol = 'scp'; defaultProtocolPort = SSH_PORT;
  } else if (tryProtocol('sftp')) {
    aProtocol = 'sftpOnly'; defaultProtocolPort = SSH_PORT;
  } else if (tryProtocol('ftp')) {
    aProtocol = 'ftp'; target.ftps = 'none'; defaultProtocolPort = FTP_PORT;
  } else if (tryProtocol('ftps')) {
    aProtocol = 'ftp'; aFtps = 'implicit'; defaultProtocolPort = FTPS_IMPLICIT_PORT;
  } else if (tryProtocol('ftpes')) {
    aProtocol = 'ftp'; aFtps = 'explicitTls'; defaultProtocolPort = FTP_PORT;
  } else if (tryProtocol('dav') || (httpForWebdav && tryProtocol('http'))) {
    aProtocol = 'webdav'; aFtps = 'none'; defaultProtocolPort = HTTP_PORT;
  } else if (tryProtocol('davs') || (httpForWebdav && tryProtocol('https'))) {
    aProtocol = 'webdav'; aFtps = 'implicit'; defaultProtocolPort = HTTPS_PORT;
  } else if (tryProtocol('s3plain') || tryProtocol('http')) {
    aProtocol = 's3'; aFtps = 'none'; defaultProtocolPort = HTTP_PORT;
  } else if (tryProtocol('s3') || tryProtocol('https')) {
    aProtocol = 's3'; aFtps = 'implicit'; defaultProtocolPort = HTTPS_PORT;
  } else if (tryProtocol('ssh')) {
    // ssh:// is sftp:// everywhere except when opening a terminal.
    aProtocol = 'sftpOnly'; target.puttyProtocol = 'ssh'; defaultProtocolPort = SSH_PORT;
  } else {
    protocolDefined = false;
  }

  const moveStr = (count) => { maskedUrl += aUrl.slice(0, count); aUrl = aUrl.slice(count); };

  if (protocolDefined) {
    parsedInfo |= PI.PROTOCOL_DEFINED;
    moveStr(protocolLen);
  }
  if (protocolDefined && aUrl.slice(0, 2) === '//') moveStr(2);

  const unsafe = (flags & PUF.UNSAFE) !== 0;
  const parseOnly = (flags & PUF.PARSE_ONLY) !== 0;

  if (aUrl !== '') {
    const decodedUrl = decodeUrlChars(aUrl);
    let stored = null;

    // A stored site is looked up even when a protocol was given, because
    // naming a site after a host is how a user sets a default user name for it.
    if (storedSessions && storedSessions.sessions &&
        (!protocolDefined || (flags & PUF.ALLOW_STORED_SITE_WITH_PROTOCOL))) {
      for (const candidate of storedSessions.sessions) {
        if (candidate.isWorkspace) continue;
        const n = String(candidate.name);
        let match = false;
        if (n.length === decodedUrl.length && n.toLowerCase() === decodedUrl.toLowerCase()) {
          match = true;
        } else if (n.length < decodedUrl.length && decodedUrl[n.length] === '/' &&
                   decodedUrl.slice(0, n.length).toLowerCase() === n.toLowerCase()) {
          match = true;
        }
        if (match) { stored = candidate; break; }
      }
    }

    let aRemoteDirectory = '';

    if (stored !== null) {
      copyData(target, stored);
      target.source = stored.source || SOURCE.STORED;
      let p = 1;
      while (p <= aUrl.length &&
             decodeUrlChars(aUrl.slice(0, p)).toLowerCase() !== String(stored.name).toLowerCase()) {
        p++;
      }
      aRemoteDirectory = aUrl.slice(p);
      maskedUrl += aUrl;
    } else {
      // An ad-hoc URL always reports a bad directory, whether the directory
      // came from the URL or from a raw setting.
      target.requireDirectories = true;

      if (storedSessions && storedSessions.defaultSettings) {
        copyData(target, storedSessions.defaultSettings);
      }
      target.name = '';

      let pSlash = aUrl.indexOf('/');
      if (pSlash < 0) pSlash = aUrl.length;

      const connectInfo = aUrl.slice(0, pSlash);
      const at = connectInfo.lastIndexOf('@');
      let userInfo = '';
      let hostInfo = at >= 0 ? connectInfo.slice(at + 1) : connectInfo;
      if (at >= 0) userInfo = connectInfo.slice(0, at);

      const origHostInfo = hostInfo;
      let bracket;
      if (hostInfo.length >= 2 && hostInfo[0] === '[' && (bracket = hostInfo.indexOf(']')) > 0) {
        target.hostName = hostInfo.slice(1, bracket);
        hostInfo = hostInfo.slice(bracket + 1);
        if (hostInfo !== '' && hostInfo[0] === ':') hostInfo = hostInfo.slice(1);
      } else {
        const cut = cutToChar(hostInfo, ':', true);
        target.hostName = decodeUrlChars(cut.head);
        hostInfo = cut.tail;
      }

      if (hostInfo !== '') {
        const port = tryStrToInt(decodeUrlChars(hostInfo));
        if (port !== null && port > 0 && port <= 65535) {
          target.portNumber = port;
          portNumberDefined = true;
        }
      } else if (protocolDefined) {
        // A WebDAV URL that points at a known object store is really S3.
        if (aProtocol === 'webdav' &&
            (isDomainOrSubdomain(target.hostName, S3_HOST_NAME) ||
             isDomainOrSubdomain(target.hostName, 'digitaloceanspaces.com') ||
             isDomainOrSubdomain(target.hostName, S3_GOOGLE_CLOUD_HOST_NAME) ||
             isDomainOrSubdomain(target.hostName, 'r2.cloudflarestorage.com') ||
             (isDomainOrSubdomain(target.hostName, 'oraclecloud.com') &&
              target.hostName.toLowerCase().includes('.compat.objectstorage.')))) {
          aProtocol = 's3';
        }
        target.portNumber = defaultProtocolPort;
      }

      if (protocolDefined) target.ftps = aFtps;

      const userCut = cutToChar(userInfo, URL_PARAM_SEPARATOR, false);
      let connectionParams = userCut.tail;
      userInfo = userCut.head;

      const rawSettings = new Map();
      while (connectionParams !== '') {
        const paramCut = cutToChar(connectionParams, URL_PARAM_SEPARATOR, false);
        connectionParams = paramCut.tail;
        const nameCut = cutToChar(paramCut.head, URL_PARAM_VALUE_SEPARATOR, false);
        const paramName = nameCut.head;
        const paramValue = nameCut.tail;
        if (paramName.toLowerCase() === URL_HOSTKEY_PARAM_NAME) {
          target.hostKey = decodeUrlChars(paramValue);
          // A fingerprint given in the URL does not override the cache — it
          // is an assertion about the host, not a decision to replace it.
          target.overrideCachedHostKey = false;
        } else if (paramName.toLowerCase().startsWith(URL_RAW_SETTINGS_PARAM_PREFIX)) {
          const aName = decodeUrlChars(paramName.slice(URL_RAW_SETTINGS_PARAM_PREFIX.length));
          const value = decodeUrlChars(paramValue);
          // TStrings.Values with an empty value removes the entry.
          if (value === '') rawSettings.delete(aName);
          else rawSettings.set(aName, value);
        }
      }

      if (rawSettings.size > 0) {
        const lines = [...rawSettings].map(([k, v]) => `${k}=${v}`);
        const r = applyRawSettings(target, lines, { unsafe, loadName: true });
        parsedInfo |= r.parsedInfo;
      }

      const hasPasswordInUrl = userInfo.includes(':');
      const userCut2 = cutToChar(userInfo, ':', false);
      const rawUserName = userCut2.head;
      target.userName = decodeUrlChars(rawUserName);
      target.password = decodeUrlChars(userCut2.tail);
      // An explicitly empty password (`user:@host`) is not "no password": it
      // is a password that happens to be empty, and must not prompt.
      if (hasPasswordInUrl && target.password === '') target.password = EMPTY_STRING_MARKER;

      const remoteWithParams = aUrl.slice(pSlash);
      const dirCut = cutToChar(remoteWithParams, URL_PARAM_SEPARATOR, false);
      aRemoteDirectory = dirCut.head;
      let sessionParams = dirCut.tail;

      while (sessionParams !== '') {
        const cut = cutToChar(sessionParams, URL_PARAM_SEPARATOR, false);
        sessionParams = cut.tail;
        const nameCut = cutToChar(cut.head, URL_PARAM_VALUE_SEPARATOR, false);
        if (nameCut.head.toLowerCase() === URL_SAVE_PARAM_NAME) {
          const n = tryStrToInt(nameCut.tail);
          target.saveOnly = (n === null ? 1 : n) !== 0;
        }
      }

      maskedUrl += rawUserName;
      if (hasPasswordInUrl) maskedUrl += ':' + PASSWORD_MASK;
      if (rawUserName !== '' || hasPasswordInUrl) maskedUrl += '@';
      maskedUrl += origHostInfo + aRemoteDirectory;
    }

    if (aRemoteDirectory !== '' && aRemoteDirectory !== '/') {
      if (aRemoteDirectory[aRemoteDirectory.length - 1] !== '/' && wantFileName) {
        const slash = aRemoteDirectory.lastIndexOf('/');
        fileName = decodeUrlChars(aRemoteDirectory.slice(slash + 1));
        aRemoteDirectory = aRemoteDirectory.slice(0, slash + 1);
      }
      target.remoteDirectory = decodeUrlChars(aRemoteDirectory);
      // True already for an ad-hoc URL, but a "storedsite/path/" URL should
      // report a bad path too.
      target.requireDirectories = true;
    }
  } else {
    if (storedSessions && storedSessions.defaultSettings) {
      copyData(target, storedSessions.defaultSettings);
    }
    parsedInfo |= PI.DEFAULTS_ONLY;
  }

  if (protocolDefined) target.protocol = aProtocol;

  let passwordsFromFiles = false;
  if (options) {
    const r = applyOptionsToSession(target, options, { unsafe, parseOnly, portNumberDefined });
    parsedInfo |= r.parsedInfo;
    passwordsFromFiles = r.passwordsFromFiles;
  }

  // The magic empty-string marker never leaves this module.
  if (target.password === EMPTY_STRING_MARKER) target.password = '';

  return { ok: true, data: target, parsedInfo, fileName, maskedUrl, passwordsFromFiles };
}

/**
 * The switch half of ParseUrl: the options that override what the URL said.
 * Deliberately does not clear piDefaultsOnly — a switch alone must not make a
 * session look connectable.
 */
function applyOptionsToSession(target, options, { unsafe = false, parseOnly = false, portNumberDefined = false } = {}) {
  let parsedInfo = 0;
  let passwordsFromFiles = false;
  const opts = options instanceof Options ? options : Options.fromArgs(options);

  const value = (name) => {
    const r = opts.findSwitchValue(name);
    return r.found ? r.value : null;
  };

  let v;
  if ((v = value('username')) !== null) target.userName = v;
  if ((v = value('password')) !== null) target.password = v;
  if ((v = value('SessionName')) !== null) target.name = v;
  if ((v = value('newpassword')) !== null) { target.changePassword = true; target.newPassword = v; }
  if ((v = value('privatekey')) !== null) target.publicKeyFile = v;
  if ((v = value('clientcert')) !== null) target.tlsCertificateFile = v;
  if ((v = value(PASSPHRASE_OPTION)) !== null) target.passphrase = v;
  if ((v = value('timeout')) !== null) {
    const n = tryStrToInt(v);
    if (n === null) throw new Error(`'${v}' is not a valid number.`);
    target.timeout = n;
  }
  if ((v = value('hostkey')) !== null || (v = value('certificate')) !== null) {
    target.hostKey = v;
    target.overrideCachedHostKey = true;
  }

  target.ftpPasvMode = opts.switchValueBool('passive', target.ftpPasvMode);

  if (opts.findSwitch('implicit')) {
    const enabled = opts.switchValueBool('implicit', true);
    target.ftps = enabled ? 'implicit' : 'none';
    if (!portNumberDefined && enabled) target.portNumber = FTPS_IMPLICIT_PORT;
  }
  // Backward compatibility with 5.5.x.
  if (opts.findSwitch('explicitssl')) {
    const enabled = opts.switchValueBool('explicitssl', true);
    target.ftps = enabled ? 'explicitSsl' : 'none';
    if (!portNumberDefined && enabled) target.portNumber = FTP_PORT;
  }
  if (opts.findSwitch('explicit') || opts.findSwitch('explicittls')) {
    const switchName = opts.findSwitch('explicit') ? 'explicit' : 'explicittls';
    const enabled = opts.switchValueBool(switchName, true);
    target.ftps = enabled ? 'explicitTls' : 'none';
    if (!portNumberDefined && enabled) target.portNumber = FTP_PORT;
  }

  if (opts.findSwitch(RAW_SETTINGS_OPTION)) {
    const r = opts.findSwitchParams(RAW_SETTINGS_OPTION);
    if (r.found && r.params.length > 0) {
      const applied = applyRawSettings(target, r.params, { unsafe, loadName: false });
      parsedInfo |= applied.parsedInfo;
    }
  }

  // -passwordsfromfiles turns every secret field into a file name whose first
  // line is the real secret. It is skipped in parse-only mode so a one-shot
  // password pipe is not consumed by an instance that is only inspecting the
  // URL in order to hand it to another one. The read itself belongs to the
  // caller (readPasswordsFromFiles), which is why this only reports it.
  if (opts.findSwitch('passwordsfromfiles') && !parseOnly) passwordsFromFiles = true;

  return { parsedInfo, passwordsFromFiles };
}

/**
 * ReadPasswordsFromFiles. Each secret field holds a file name whose first line
 * is the real secret. The read is injected so this module never touches the
 * file system, and results are cached because the "file" is often a named pipe
 * that can only be read once.
 */
function readPasswordsFromFiles(data, readFirstLine) {
  const cache = new Map();
  const read = (name) => {
    if (!name) return '';
    if (cache.has(name)) return cache.get(name);
    let value = '';
    try { value = readFirstLine(name); } catch { value = ''; }
    value = value == null ? '' : String(value);
    cache.set(name, value);
    return value;
  };
  for (const f of ['password', 'newPassword', 'proxyPassword', 'tunnelPassword',
    'tunnelPassphrase', 'passphrase', 'encryptKey']) {
    data[f] = read(data[f]);
  }
  return data;
}

/* ================================================================== */
/* tunnel                                                              */
/* ================================================================== */

function configureTunnel(data, portNumber) {
  data.origHostName = data.hostName;
  data.origPortNumber = data.portNumber;
  data.origProxyMethod = data.proxyMethod;
  data.hostName = '127.0.0.1';
  data.portNumber = portNumber;
  // The proxy settings belong to the tunnel, not to the session inside it.
  data.proxyMethod = 'none';
  data.logicalHostName = data.origHostName;
  return data;
}

function rollbackTunnel(data) {
  data.hostName = data.origHostName;
  data.portNumber = data.origPortNumber;
  data.proxyMethod = data.origProxyMethod;
  data.logicalHostName = '';
  return data;
}

/** CreateTunnelData — the session that carries the tunnel itself. */
function createTunnelData(data, tunnelLocalPortNumber, defaultSettings = null) {
  const t = defaultSettings ? cloneSessionData(defaultSettings) : defaultSessionData();
  t.name = `${sessionName(data)} (tunnel)`;
  t.tunnel = false;
  t.hostName = data.tunnelHostName;
  t.portNumber = data.tunnelPortNumber;
  t.userName = data.tunnelUserName;
  t.password = data.tunnelPassword;
  t.publicKeyFile = data.tunnelPublicKeyFile;
  t.detachedCertificate = '';
  t.passphrase = data.tunnelPassphrase;

  let host = data.hostName;
  if (isIPv6Literal(host)) host = escapeIPv6Literal(host);
  t.tunnelPortFwd = `L${tunnelLocalPortNumber}\t${host}:${data.portNumber}`;
  t.hostKey = data.tunnelHostKey;

  for (const f of ['proxyMethod', 'proxyHost', 'proxyPort', 'proxyUsername', 'proxyPassword',
    'proxyTelnetCommand', 'proxyLocalCommand', 'proxyDNS', 'proxyLocalhost']) {
    t[f] = data[f];
  }
  // Most SSH options are inherited, but not the private key or the bug list.
  for (const f of ['compression', 'cipherList', 'ssh2DES', 'kexList', 'rekeyData', 'rekeyTime',
    'sshNoUserAuth', 'authGSSAPI', 'authGSSAPIKEX', 'gssapiFwdTGT', 'tryAgent', 'agentFwd',
    'authKI', 'authKIPassword']) {
    t[f] = deepClone(data[f]);
  }
  return t;
}

function tunnelAutoassignLocalPortNumber(data) { return data.tunnelLocalPortNumber <= 0; }

/** DisableAuthentationsExceptPassword — used when a server demands a password. */
function disableAuthenticationsExceptPassword(data) {
  data.sshNoUserAuth = false;
  data.authKI = false;
  data.authKIPassword = false;
  data.authGSSAPI = false;
  data.authGSSAPIKEX = false;
  data.publicKeyFile = '';
  data.detachedCertificate = '';
  data.tlsCertificateFile = '';
  data.passphrase = '';
  data.tryAgent = false;
  return data;
}

/** ExpandEnvironmentVariables over the fields that may contain one. */
function expandEnvironmentVariables(str, env = process.env) {
  return String(str).replace(/%([^%]+)%/g, (m, name) => {
    const v = env[name] !== undefined ? env[name] : env[String(name).toUpperCase()];
    return v === undefined ? m : v;
  });
}

function expandSessionEnvironmentVariables(data, env = process.env) {
  data.hostName = expandEnvironmentVariables(data.hostName, env);
  data.userName = expandEnvironmentVariables(data.userName, env);
  data.publicKeyFile = expandEnvironmentVariables(data.publicKeyFile, env);
  data.detachedCertificate = expandEnvironmentVariables(data.detachedCertificate, env);
  return data;
}

/* ================================================================== */
/* INI import / export                                                 */
/* ================================================================== */

/**
 * Parse an INI file into `{ section: { key: value } }`. Deliberately tolerant
 * in the same places a Delphi TIniFile is: a value may contain `=`, whitespace
 * around the separator is kept (WinSCP writes none), and a duplicate key wins
 * last.
 */
function parseIniFile(text) {
  const sections = Object.create(null);
  let current = '';
  sections[current] = Object.create(null);
  for (const rawLine of String(text).split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1);
      if (!sections[current]) sections[current] = Object.create(null);
      continue;
    }
    const p = line.indexOf('=');
    if (p < 0) continue;
    sections[current][line.slice(0, p)] = line.slice(p + 1);
  }
  return sections;
}

function formatIniFile(sections) {
  const out = [];
  for (const name of Object.keys(sections)) {
    if (name === '') continue;
    out.push(`[${name}]`);
    for (const key of Object.keys(sections[name])) out.push(`${key}=${sections[name][key]}`);
    out.push('');
  }
  return out.join('\r\n');
}

const SESSIONS_SUBKEY = 'Sessions';

/**
 * Import sites from a WinSCP INI file. Sessions live under `[Sessions\<name>]`
 * with the name PuTTY-escaped; `Default Settings` is the stored defaults rather
 * than a site, and is returned separately.
 *
 * Each site is loaded from the *factory* defaults, not from the stored default
 * settings — that is what TStoredSessionList::Load does with UseDefaults false,
 * and it has to match how the file was written (every site is saved against the
 * factory defaults too). `useDefaults` turns on the other behaviour, which is
 * the one the PuTTY import uses because PuTTY stores far less than we do.
 */
function importSessionsFromIni(text, { useDefaults = false } = {}) {
  const sections = typeof text === 'string' ? parseIniFile(text) : text;
  const prefix = SESSIONS_SUBKEY + '\\';
  let defaultSettings = null;
  const raw = [];

  for (const section of Object.keys(sections)) {
    if (!section.startsWith(prefix)) continue;
    const name = unMungeStr(section.slice(prefix.length));
    if (name === DEFAULT_SETTINGS_NAME) {
      defaultSettings = { name, values: sections[section] };
    } else {
      raw.push({ name, values: sections[section] });
    }
  }

  const defaults = defaultSettings
    ? loadSession(defaultSettings.values, { name: DEFAULT_SETTINGS_NAME }).data
    : null;

  const sessions = raw.map((entry) => {
    const base = (useDefaults && defaults) ? cloneSessionData(defaults) : defaultSessionData();
    base.name = entry.name;
    const storage = new KeyValueStorage(entry.values);
    doLoad(base, storage, {});
    base.modified = false;
    base.source = SOURCE.STORED;
    return base;
  });

  return { sessions, defaultSettings: defaults };
}

/**
 * Export sites to the INI text WinSCP itself would write. Every site — and the
 * stored default settings themselves — is measured against the factory
 * defaults, because that is the baseline the reader will use.
 */
function exportSessionsToIni(sessions, { defaultSettings = null } = {}) {
  const factory = defaultSessionData();
  const sections = Object.create(null);
  if (defaultSettings) {
    sections[`${SESSIONS_SUBKEY}\\${mungeStr(DEFAULT_SETTINGS_NAME, false)}`] =
      saveSession(defaultSettings, { defaultData: factory });
  }
  for (const s of sessions) {
    sections[`${SESSIONS_SUBKEY}\\${mungeStr(s.name, false)}`] =
      saveSession(s, { defaultData: factory });
  }
  return formatIniFile(sections);
}

/* ================================================================== */
/* PuTTY import                                                        */
/* ================================================================== */

/**
 * Import a PuTTY session. PuTTY stores the same keys with different values in
 * a few places, which is what `puttyImport` in doLoad accounts for:
 *  - TcpNoDelay is left alone, because psftp/pscp ignore PuTTY's preference;
 *  - the "local proxy" pointing at another SSH host becomes our tunnel;
 *  - string values are not munged, so they are read verbatim.
 * The protocol is not stored by PuTTY the way we store it, so an imported
 * session keeps the factory protocol unless `Protocol=ssh` says otherwise.
 *
 * `defaultSettings` is the local stored defaults, copied in first — PuTTY
 * stores far less than a WinSCP site does, so the import is loaded on top of
 * them rather than on top of the factory values (TStoredSessionList::Load with
 * UseDefaults).
 */
function importPuttySession(values, name = '', { defaultSettings = null } = {}) {
  const data = defaultSettings ? cloneSessionData(defaultSettings) : defaultSessionData();
  data.name = name;
  const storage = new KeyValueStorage(values, { mungeValues: false });
  doLoad(data, storage, { puttyImport: true });
  // PuTTY's own session name is escaped the same way ours is.
  data.name = name;
  data.modified = false;
  data.source = SOURCE.STORED;
  return data;
}

/**
 * Import every PuTTY session out of a `.reg` export of
 * `HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions`. That file is the
 * only portable form a PuTTY session takes, and it is what WinSCP's import
 * dialog reads when the registry is not available.
 */
function importSessionsFromPuttyReg(text, { defaultSettings = null } = {}) {
  const sessions = [];
  let current = null;
  const lines = String(text).split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*\[/.test(line)) {
      const key = line.trim().replace(/^\[/, '').replace(/\]$/, '');
      const m = /SimonTatham\\PuTTY\\Sessions\\(.+)$/i.exec(key);
      current = m ? { name: unMungeStr(m[1]), values: {} } : null;
      if (current) sessions.push(current);
      continue;
    }
    if (!current) continue;
    // A .reg value line continues while it ends with a backslash.
    while (/\\\s*$/.test(line) && i + 1 < lines.length) {
      line = line.replace(/\\\s*$/, '') + lines[++i].trim();
    }
    const m = /^\s*"([^"]*)"\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value.startsWith('dword:')) {
      current.values[key] = String(parseInt(value.slice(6), 16));
    } else if (value.startsWith('"')) {
      // .reg escapes backslash and quote with a backslash.
      current.values[key] = value.slice(1, value.lastIndexOf('"'))
        .replace(/\\(.)/g, '$1');
    }
  }
  return sessions.map((s) => importPuttySession(s.values, s.name, { defaultSettings }));
}

/**
 * Export a session in the shape a PuTTY session expects. Unlike our own store,
 * this writes every option: PuTTY has no notion of our defaults, so an omitted
 * key would silently fall back to PuTTY's own — which is why TSessionData::Save
 * for a PuTTY export passes no baseline at all.
 */
function exportPuttySession(data, { defaultData = null } = {}) {
  return saveSession(data, { defaultData, puttyExport: true });
}

/* ================================================================== */
/* OpenSSH config import                                               */
/* ================================================================== */

function isValidOpensshLine(line) {
  return line !== '' && line[0] !== '#';
}

/**
 * ParseOpensshDirective. A directive may be quoted, and the separator is
 * whitespace, `=`, or whitespace around an `=`.
 */
function parseOpensshDirective(aLine) {
  if (!isValidOpensshLine(String(aLine).trim())) return null;
  let line = String(aLine).trim();
  let directive;
  if (line.startsWith('"')) {
    line = line.slice(1);
    const p = line.indexOf('"');
    if (p < 0) return null;
    directive = line.slice(0, p);
    line = line.slice(p + 1).trim();
  } else {
    const p = line.search(/[ \t=]/);
    if (p < 0) return null;
    directive = line.slice(0, p);
    line = line.slice(p);
    let trimChars = ' \t=';
    while (line !== '' && trimChars.includes(line[0])) {
      if (line[0] === '=') trimChars = ' \t';
      line = line.slice(1);
    }
  }
  return line === '' ? null : { directive, value: line };
}

/** CutOpensshToken: `\`-escapes, single and double quotes. */
function cutOpensshToken(s) {
  const NO_QUOTE = '';
  let quote = NO_QUOTE;
  let result = '';
  let p = 0;
  const str = String(s);
  while (p < str.length) {
    const c = str[p];
    if (c === '\\' && p + 1 < str.length &&
        (str[p + 1] === "'" || str[p + 1] === '"' || str[p + 1] === '\\' ||
         (quote === NO_QUOTE && str[p + 1] === ' '))) {
      result += str[p + 1];
      p++;
    } else if (quote === NO_QUOTE && (c === ' ' || c === '\t')) {
      break;
    } else if (quote === NO_QUOTE && (c === "'" || c === '"')) {
      quote = c;
    } else if (quote !== NO_QUOTE && quote === c) {
      quote = NO_QUOTE;
    } else {
      result += c;
    }
    p++;
  }
  return { token: result, rest: str.slice(p).trim() };
}

function convertPathFromOpenssh(path, home = process.env.USERPROFILE || process.env.HOME || '') {
  let result = String(path).split('/').join('\\');
  if (result.startsWith('~')) result = home + result.slice(1);
  return result;
}

function opensshBoolValue(value) { return String(value).toLowerCase() === 'yes'; }

/**
 * ImportFromOpenssh. `Host` sections are matched against the session's name,
 * with `!` negating a pattern; a `Match` block is always skipped because its
 * conditions cannot be evaluated here. The first value of a directive wins, as
 * in OpenSSH itself.
 */
function importFromOpenssh(data, lines, { matches = null } = {}) {
  let skippingSection = false;
  const usedDirectives = new Set();
  const nameMatches = matches || ((pattern, name) => {
    // OpenSSH host patterns: `*` and `?`, matched case-insensitively.
    const rx = new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .split('*').join('.*').split('?').join('.') + '$', 'i');
    return rx.test(name);
  });

  for (const rawLine of lines) {
    const parsed = parseOpensshDirective(rawLine);
    if (!parsed) continue;
    const { directive } = parsed;
    let args = parsed.value;

    if (directive.toLowerCase() === 'host') {
      skippingSection = true;
      while (args !== '') {
        const cut = cutOpensshToken(args);
        args = cut.rest;
        let m = cut.token;
        const negated = m !== '' && m[0] === '!';
        if (negated) m = m.slice(1);
        if (nameMatches(m, data.name)) {
          if (negated) { skippingSection = true; break; }
          skippingSection = false;   // keep looking, a later `!` still wins
        }
      }
    } else if (directive.toLowerCase() === 'match') {
      skippingSection = true;
    } else if (!skippingSection && !usedDirectives.has(directive.toLowerCase())) {
      const cut = cutOpensshToken(args);
      const value = cut.token;
      // Every directive we support takes exactly one token.
      if (cut.rest !== '') continue;
      switch (directive.toLowerCase()) {
        case 'addressfamily':
          data.addressFamily = value.toLowerCase() === 'inet' ? 'ipv4'
            : value.toLowerCase() === 'inet6' ? 'ipv6' : 'auto';
          break;
        case 'bindaddress': data.sourceAddress = value; break;
        case 'compression': data.compression = opensshBoolValue(value); break;
        case 'forwardagent': data.agentFwd = opensshBoolValue(value); break;
        case 'gssapiauthentication': data.authGSSAPI = opensshBoolValue(value); break;
        case 'gssapidelegatecredentials': data.authGSSAPIKEX = opensshBoolValue(value); break;
        case 'hostname': data.hostName = value; break;
        case 'identityfile': data.publicKeyFile = convertPathFromOpenssh(value); break;
        case 'certificatefile': data.detachedCertificate = convertPathFromOpenssh(value); break;
        case 'kbdinteractiveauthentication': data.authKI = opensshBoolValue(value); break;
        case 'port': {
          const n = tryStrToInt(value);
          if (n !== null) data.portNumber = n;
          break;
        }
        case 'user': data.userName = value; break;
        case 'proxyjump': {
          // Only a single jump host maps onto our one tunnel.
          if (!value.includes(',')) {
            const jump = parseUrl(value).data;
            if (jump.hostName !== '') {
              jump.name = jump.hostName;
              importFromOpenssh(jump, lines, { matches });
              data.tunnel = true;
              data.tunnelHostName = jump.hostName;
              data.tunnelPortNumber = jump.portNumber;
              data.tunnelUserName = jump.userName;
              data.tunnelPassword = jump.password;
              data.tunnelPublicKeyFile = jump.publicKeyFile;
            }
          }
          break;
        }
        default: break;
      }
      usedDirectives.add(directive.toLowerCase());
    }
  }
  return data;
}

/* ================================================================== */
/* stored session list helpers                                         */
/* ================================================================== */

function isInFolder(sessions, name) {
  const prefix = String(name).endsWith('/') ? String(name) : String(name) + '/';
  return sessions.some((s) => String(s.name).toLowerCase().startsWith(prefix.toLowerCase()));
}

function firstFolderOrWorkspaceSession(sessions, name) {
  if (!name) return null;
  const prefix = String(name).endsWith('/') ? String(name) : String(name) + '/';
  for (const s of sessions) {
    if (String(s.name).toLowerCase().startsWith(prefix.toLowerCase())) return s;
  }
  return null;
}

function isFolder(sessions, name) {
  const s = firstFolderOrWorkspaceSession(sessions, name);
  return s !== null && !s.isWorkspace;
}

function isWorkspace(sessions, name) {
  const s = firstFolderOrWorkspaceSession(sessions, name);
  return s !== null && !!s.isWorkspace;
}

function getWorkspaces(sessions) {
  const out = new Set();
  for (const s of sessions) if (s.isWorkspace) out.add(folderName(s));
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Resolve a workspace entry that is only a link to a stored site. */
function resolveWorkspaceData(sessions, data) {
  let d = data;
  const seen = new Set();
  while (d && d.link) {
    if (seen.has(d.link)) return null;      // a link cycle resolves to nothing
    seen.add(d.link);
    d = sessions.find((s) => s.name === d.link) || null;
  }
  return d;
}

/**
 * FindSame — the stored site this data came from, by name. A hidden, unnamed
 * or workspace entry has no stored counterpart by definition.
 */
function findSame(sessions, data) {
  if (isHidden(data.name) || data.name === '' || data.isWorkspace) return null;
  return sessions.find((s) => String(s.name).toLowerCase() === String(data.name).toLowerCase()) || null;
}

/**
 * SaveWorkspaceData — a workspace member is stored as a link when the site it
 * came from still exists, and as a full copy when it does not, so closing a
 * workspace never loses an ad-hoc session.
 */
function saveWorkspaceData(sessions, data, index) {
  const result = defaultSessionData();
  const same = findSame(sessions, data);
  if (same) {
    copyStateData(result, data);
    result.link = data.name;
  } else {
    assignSessionData(result, data);
    result.nameOverride = data.name;
  }
  result.isWorkspace = true;
  // Hex so the list sorts in insertion order rather than logically.
  result.name = index.toString(16).toUpperCase().padStart(4, '0');
  return result;
}

module.exports = {
  // constants
  SSH_PORT, FTP_PORT, FTPS_IMPLICIT_PORT, HTTP_PORT, HTTPS_PORT, PROXY_PORT,
  DEFAULT_SEND_BUF, ANONYMOUS_USER_NAME, ANONYMOUS_PASSWORD, PASSWORD_MASK,
  WINSCP_PROTOCOL_PREFIX, URL_PARAM_SEPARATOR, URL_PARAM_VALUE_SEPARATOR,
  URL_HOSTKEY_PARAM_NAME, URL_SAVE_PARAM_NAME, URL_RAW_SETTINGS_PARAM_PREFIX,
  PASSPHRASE_OPTION, RAW_SETTINGS_OPTION, SESSION_NAME_SETTINGS_NAME,
  HIDDEN_PREFIX, DEFAULT_SETTINGS_NAME, TITLE_SEPARATOR,
  SUF, PUF, PI, SOURCE,
  FS_PROTOCOL, FS_PROTOCOL_NAMES, AUTO_SWITCH, PING_TYPE, FTP_PING_TYPE,
  PROXY_METHOD, ADDRESS_FAMILY, FTPS, DST_MODE, EOL_TYPE, S3_URL_STYLE, TLS_VERSION,
  CIPHER_NAMES, KEX_NAMES, HOSTKEY_NAMES, GSSLIB_NAMES,
  DEFAULT_CIPHER_LIST, DEFAULT_KEX_LIST, DEFAULT_HOSTKEY_LIST, DEFAULT_GSSLIB_LIST,
  SSH_BUG_KEYS, SSH_BUG_FIELDS, OPTIONS, OBSOLETE_KEYS,
  SESSION_DATA_DEFAULTS, FACTORY_DEFAULTS, WINSCP_FACTORY_OVERRIDES,
  BASE_PROPERTIES, META_PROPERTIES, ADVANCED_PROPERTIES,

  // model
  defaultSessionData, appDefaultSessionData, cloneSessionData, assignSessionData,
  copyData, copyStateData, copyNonCoreData, copyDirectoriesStateData, hasStateData,
  isSame, isSameSite, setHostName, setTunnelHostName, defaultProxy,
  detectReturnVar, setDetectReturnVar, isDefaultShell, setDefaultShell,
  normalizedPuttyProtocol,

  // identity
  isSshProtocol, normalizeProtocol, defaultPort, getDefaultPort, usesSsh, isSecure,
  canLogin, canOpen, isLocalBrowser, isHidden, nameWithoutHiddenPrefix, hasSessionName,
  makeValidName, validateName, validatePath, extractLocalName, extractFolderName,
  composePath, defaultSessionName, sessionName, localName, folderName,
  formatSiteKey, siteKey, sessionKey, internalStorageKey, isInFolderOrWorkspace, infoTip,

  // passwords
  hasPassword, hasAnySessionPassword, hasAnyPassword, clearSessionPasswords, maskPasswords,
  isSensitiveOption, isOptionWithParameters, maskPasswordInOptionParameter,
  readPasswordsFromFiles,

  // munging / storage
  mungeStr, unMungeStr, mungeIniName, unMungeIniName, KeyValueStorage, storageFromLines,
  parseRawSettingsText, formatRawSettingsText,

  // serialization
  doLoad, loadSession, applyRawSettings, doSave, saveSession, saveToOptions,
  allOptionNames, savePasswordsTo, setAlgoList, algoListToString, colorToInt, intToColor,
  linesToText, textToLines,

  // URLs
  protocolUrl, generateSessionUrl, generateOpenCommandArgs, parseUrl, applyOptionsToSession,
  getRawSettingsForUrl, hasRawSettingsForUrl, normalizeFingerprint,
  encodeUrlString, encodeUrlPath, decodeUrlChars, base64ToUrlSafe, md5ToUrlSafe,
  hasIP6LiteralBrackets, stripIP6LiteralBrackets, isIPv6Literal, escapeIPv6Literal,
  isDomainOrSubdomain,

  // tunnel
  configureTunnel, rollbackTunnel, createTunnelData, tunnelAutoassignLocalPortNumber,
  disableAuthenticationsExceptPassword, expandEnvironmentVariables,
  expandSessionEnvironmentVariables,

  // import / export
  parseIniFile, formatIniFile, importSessionsFromIni, exportSessionsToIni,
  importPuttySession, importSessionsFromPuttyReg, exportPuttySession,
  parseOpensshDirective, cutOpensshToken, convertPathFromOpenssh, importFromOpenssh,

  // stored list
  isInFolder, firstFolderOrWorkspaceSession, isFolder, isWorkspace, getWorkspaces,
  resolveWorkspaceData, findSame, saveWorkspaceData,
};
