// sessioninfo.js — the portable identity/runtime part of core/SessionInfo.cpp
// and core/SessionInfo.h.
//
// SessionData owns configuration and Session owns the live connection. This
// module is the deliberately small seam between them: it turns either shape
// into the same, secret-free description for tabs, diagnostics and future IPC
// consumers. It does not replace either owner and it never stores credentials.
'use strict';

const SD = require('./sessiondata');

const SESSION_INFO_VERSION = 1;

/** TSessionStatus, expressed in the strings used by the JavaScript session. */
const SESSION_STATUS = Object.freeze({
  CLOSED: 'closed',
  OPENING: 'opening',
  OPENED: 'opened',
});

const SESSION_STATUS_CODES = Object.freeze({
  [SESSION_STATUS.CLOSED]: 0,
  [SESSION_STATUS.OPENING]: 1,
  [SESSION_STATUS.OPENED]: 2,
});

/** The user-visible protocol identity is separate from its configured id. */
const PROTOCOL_IDENTITIES = Object.freeze({
  local: Object.freeze({ baseName: 'Local', name: 'Local', security: '' }),
  scp: Object.freeze({ baseName: 'SCP', name: 'SCP', security: 'SSH' }),
  sftp: Object.freeze({ baseName: 'SFTP', name: 'SFTP', security: 'SSH' }),
  sftpOnly: Object.freeze({ baseName: 'SFTP', name: 'SFTP', security: 'SSH' }),
  ftp: Object.freeze({ baseName: 'FTP', name: 'FTP', secureName: 'FTPS', security: 'TLS/SSL' }),
  webdav: Object.freeze({ baseName: 'WebDAV', name: 'WebDAV', secureName: 'WebDAVS', security: 'TLS/SSL' }),
  s3: Object.freeze({ baseName: 'S3', name: 'Amazon S3', security: 'HTTPS' }),
});

const SECRET_KEY = /(?:pass(?:word|phrase)?|secret|token|privatekey|credential|accesskey|secretkey)/i;

// Fixed order is part of the public serialization contract. stableStringify
// additionally sorts nested objects, so an adapter cannot make snapshots
// differ merely by inserting server properties in a different order.
const SERIAL_FIELDS = [
  'version', 'sessionId', 'siteId', 'protocol', 'protocolBaseName',
  'protocolName', 'securityProtocolName', 'hostName', 'portNumber', 'userName',
  'sessionName', 'displayName', 'hostPort', 'sessionKey', 'folder', 'color',
  'note', 'localPath', 'remotePath', 'home', 'status', 'stateStatus',
  'connected', 'openedAt', 'loginTime', 'infoTip', 'serverInfo', 'capabilities',
  'cryptographicClientToServer', 'compressionClientToServer',
  'cryptographicServerToClient', 'compressionServerToClient', 'sshVersionString',
  'sshImplementation', 'hostKeyFingerprintSHA256', 'hostKeyFingerprintMD5',
  'certificateFingerprintSHA1', 'certificateFingerprintSHA256', 'certificate',
  'certificateVerifiedManually',
];

const FILE_SYSTEM_SERIAL_FIELDS = [
  'version', 'protocolBaseName', 'protocolName', 'remoteSystem', 'additionalInfo',
  'serverVersion', 'serverSoftware', 'sessionProtocol', 'cryptographicProtocol',
  'compression', 'hostKey', 'certificate', 'capabilities', 'home', 'space',
  'spaceError',
];

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }
  return value;
}

function sanitize(value, key = '') {
  if (SECRET_KEY.test(key)) return undefined;
  if (Array.isArray(value)) return value.map((v) => sanitize(v)).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (SECRET_KEY.test(k)) continue;
      const next = sanitize(value[k], k);
      if (next !== undefined) out[k] = next;
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function asString(value) {
  return value === undefined || value === null ? '' : String(value);
}

function asPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

function asDate(value, fallback = new Date()) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime());
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (typeof value === 'string' && value !== '') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(fallback instanceof Date ? fallback.getTime() : Date.now());
}

function isoDate(value) { return asDate(value).toISOString(); }

function protocolIdentity(protocol, secure) {
  const key = asString(protocol || 'sftp');
  const known = PROTOCOL_IDENTITIES[key] || {
    baseName: key ? key.toUpperCase() : 'Unknown',
    name: key ? key.toUpperCase() : 'Unknown',
    security: '',
  };
  const secureName = secure && known.secureName ? known.secureName : known.name;
  const security = secure && known.security ? known.security : (known.security === 'SSH' ? 'SSH' : '');
  return { protocol: key, baseName: known.baseName, name: secureName, security };
}

function endpoint(hostName, portNumber) {
  const host = asString(hostName);
  if (!host) return portNumber ? `:${portNumber}` : '';
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return portNumber ? `${bracketed}:${portNumber}` : bracketed;
}

function sessionDataWithDefaults(source) {
  const data = SD.defaultSessionData();
  for (const [key, value] of Object.entries(source || {})) data[key] = clone(value);
  return data;
}

function stateStatus(value) {
  const s = asString(value).toLowerCase();
  if (s === 'connected' || s === 'opened' || s === 'open') return SESSION_STATUS.OPENED;
  if (s === 'connecting' || s === 'opening' || s === 'reconnecting') return SESSION_STATUS.OPENING;
  return SESSION_STATUS.CLOSED;
}

function pickRuntimeField(runtime, adapter, key, fallback = '') {
  if (runtime && runtime[key] !== undefined) return runtime[key];
  if (adapter && adapter[key] !== undefined) return adapter[key];
  return fallback;
}

function certificateField(runtime, adapter, key, fallback = '') {
  const direct = pickRuntimeField(runtime, adapter, key, undefined);
  if (direct !== undefined && direct !== '') return direct;
  const certificate = (runtime && runtime.certificate) ||
    (adapter && adapter.certificate) ||
    (runtime && runtime.serverInfo && runtime.serverInfo.certificate) ||
    (adapter && adapter.serverInfo && adapter.serverInfo.certificate);
  if (!certificate || typeof certificate !== 'object') return fallback;
  if (key === 'certificate') return certificate;
  return certificate[key] === undefined ? fallback : certificate[key];
}

function capabilitySnapshot(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = !!value[key];
  return out;
}

/**
 * A secret-free snapshot of TSessionInfo plus the session identity needed by
 * the current tab/session surfaces.
 */
class SessionInfo {
  constructor(options = {}) {
    const data = sessionDataWithDefaults(options.session || options.data || options);
    const runtime = options.runtime || options;
    const adapter = runtime.adapter || null;
    const serverInfo = runtime.serverInfo || (adapter && adapter.serverInfo) || {};
    const protocol = asString(data.protocol || 'sftp');
    const secure = SD.isSecure(data);
    const identity = protocolIdentity(protocol, secure);
    const defaultPort = SD.defaultPort(protocol, data.ftps);
    const portNumber = asPort(data.portNumber, defaultPort > 0 ? defaultPort : 0);
    const statusValue = stateStatus(runtime.status || (runtime.state && runtime.state.status));

    this.version = SESSION_INFO_VERSION;
    this.sessionId = asString(runtime.sessionId || runtime.id);
    this.siteId = asString(runtime.siteId || data.id);
    this.protocol = identity.protocol;
    this.protocolBaseName = identity.baseName;
    this.protocolName = asString(pickRuntimeField(runtime, adapter, 'protocolName', identity.name));
    this.securityProtocolName = asString(pickRuntimeField(runtime, adapter, 'securityProtocolName', identity.security));
    this.hostName = asString(data.hostName);
    this.portNumber = portNumber;
    this.userName = asString(data.userName || (data.anonymous ? SD.ANONYMOUS_USER_NAME : ''));
    this.sessionName = asString(runtime.sessionName || SD.sessionName(data));
    this.displayName = asString(runtime.displayName || this.sessionName);
    this.hostPort = endpoint(this.hostName, this.portNumber);
    this.sessionKey = SD.sessionKey({ ...data, portNumber });
    this.folder = asString(data.folder || SD.folderName(data));
    this.color = asString(data.color);
    this.note = asString(data.note);
    this.localPath = asString(runtime.localPath || (runtime.state && runtime.state.localPath) || data.localDirectory);
    this.remotePath = asString(runtime.remotePath || (runtime.state && runtime.state.remotePath) || data.remoteDirectory);
    this.home = asString(runtime.home || (adapter && adapter.home) || '/');
    this.stateStatus = asString(runtime.stateStatus || (runtime.state && runtime.state.status) || statusValue);
    this.status = statusValue;
    this.connected = runtime.connected === undefined
      ? statusValue === SESSION_STATUS.OPENED
      : !!runtime.connected;
    this.openedAt = Number.isFinite(Number(runtime.openedAt || (runtime.state && runtime.state.openedAt)))
      ? Number(runtime.openedAt || (runtime.state && runtime.state.openedAt)) : 0;
    this.loginTime = asDate(runtime.loginTime || runtime.started || runtime.startTime);
    this.infoTip = SD.infoTip(data);
    this.serverInfo = sanitize(serverInfo) || {};
    this.capabilities = capabilitySnapshot(runtime.capabilities || (adapter && adapter.caps));

    // TSessionInfo's negotiated connection fields. The long names are kept in
    // the canonical snapshot; short aliases are accepted as input below.
    this.cryptographicClientToServer = asString(pickRuntimeField(runtime, adapter, 'cryptographicClientToServer', runtime.csCipher));
    this.compressionClientToServer = asString(pickRuntimeField(runtime, adapter, 'compressionClientToServer', runtime.csCompression));
    this.cryptographicServerToClient = asString(pickRuntimeField(runtime, adapter, 'cryptographicServerToClient', runtime.scCipher));
    this.compressionServerToClient = asString(pickRuntimeField(runtime, adapter, 'compressionServerToClient', runtime.scCompression));
    this.sshVersionString = asString(pickRuntimeField(runtime, adapter, 'sshVersionString'));
    this.sshImplementation = asString(pickRuntimeField(runtime, adapter, 'sshImplementation'));
    this.hostKeyFingerprintSHA256 = asString(pickRuntimeField(runtime, adapter, 'hostKeyFingerprintSHA256'));
    this.hostKeyFingerprintMD5 = asString(pickRuntimeField(runtime, adapter, 'hostKeyFingerprintMD5'));
    this.certificateFingerprintSHA1 = asString(certificateField(runtime, adapter, 'certificateFingerprintSHA1',
      certificateField(runtime, adapter, 'fingerprint')));
    this.certificateFingerprintSHA256 = asString(certificateField(runtime, adapter, 'certificateFingerprintSHA256',
      certificateField(runtime, adapter, 'fingerprint256')));
    this.certificate = sanitize(certificateField(runtime, adapter, 'certificate', null));
    this.certificateVerifiedManually = !!certificateField(runtime, adapter,
      'certificateVerifiedManually', false);
  }

  static fromSessionData(data, runtime = {}) { return new SessionInfo({ session: data, runtime }); }

  static fromSession(session) {
    if (!session || typeof session !== 'object') throw new TypeError('A live session is required.');
    return new SessionInfo({
      session: session.data || session,
      runtime: {
        id: session.id,
        state: session.state,
        connected: session.connected,
        adapter: session.adapter,
      },
    });
  }

  static fromConfig(config, siteId, runtime = {}) {
    if (!config || typeof config !== 'object') throw new TypeError('A Config instance is required.');
    const data = typeof config.resolveSite === 'function' ? config.resolveSite(siteId) : config.siteById(siteId);
    if (!data) return null;
    return SessionInfo.fromSessionData(data, { ...runtime, siteId });
  }

  /** The stable public object; credentials and arbitrary session options never cross this boundary. */
  toJSON() {
    const out = {};
    for (const key of SERIAL_FIELDS) {
      let value = this[key];
      if (key === 'loginTime') value = isoDate(this.loginTime);
      if (value !== undefined) out[key] = clone(value);
    }
    return out;
  }

  serialize() { return stableStringify(this.toJSON()); }

  static fromJSON(value) {
    let raw = value;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (e) { throw new TypeError(`Invalid SessionInfo JSON: ${e.message}`); }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('SessionInfo JSON must be an object.');
    if (Number(raw.version) !== SESSION_INFO_VERSION) {
      throw new Error(`Unsupported SessionInfo version: ${raw.version}`);
    }
    return new SessionInfo({
      session: {
        id: raw.siteId,
        protocol: raw.protocol,
        hostName: raw.hostName,
        portNumber: raw.portNumber,
        userName: raw.userName,
        name: raw.sessionName,
        folder: raw.folder,
        color: raw.color,
        note: raw.note,
      },
      runtime: raw,
    });
  }

  /** The fields used by a tab title and connection prompt. */
  displayFields() {
    return {
      sessionName: this.sessionName,
      displayName: this.displayName,
      protocol: this.protocolName,
      hostName: this.hostName,
      portNumber: this.portNumber,
      userName: this.userName,
      hostPort: this.hostPort,
      status: this.status,
    };
  }

  isSameEndpoint(other) {
    const info = other instanceof SessionInfo ? other : new SessionInfo({ session: other });
    return this.protocol === info.protocol && this.hostName === info.hostName &&
      this.portNumber === info.portNumber && this.userName === info.userName;
  }

  // Names used by TSessionInfo in the C++ source. The canonical serialized
  // names above are explicit about direction, while these aliases keep the
  // port pleasant to use beside upstream references and existing log code.
  get csCipher() { return this.cryptographicClientToServer; }
  get csCompression() { return this.compressionClientToServer; }
  get scCipher() { return this.cryptographicServerToClient; }
  get scCompression() { return this.compressionServerToClient; }
  get CSCipher() { return this.csCipher; }
  get CSCompression() { return this.csCompression; }
  get SCCipher() { return this.scCipher; }
  get SCCompression() { return this.scCompression; }
}

/** The TFileSystemInfo portion of the same upstream header. */
class FileSystemInfo {
  constructor(options = {}) {
    const sessionInfo = options.sessionInfo instanceof SessionInfo
      ? options.sessionInfo : new SessionInfo({ session: options.session || options });
    const source = options.info || options.serverInfo || {};
    this.version = SESSION_INFO_VERSION;
    this.protocolBaseName = sessionInfo.protocolBaseName;
    this.protocolName = asString(source.protocol || sessionInfo.protocolName);
    this.remoteSystem = asString(source.remoteSystem || source.system);
    this.additionalInfo = sanitize(source.additional || source.additionalInfo || {}) || {};
    this.serverVersion = asString(source.version || source.serverVersion);
    this.serverSoftware = asString(source.software);
    this.sessionProtocol = asString(source.sessionProtocol);
    this.cryptographicProtocol = asString(source.cryptographicProtocol);
    this.compression = asString(source.compression);
    this.hostKey = sanitize(source.hostKey || null);
    this.certificate = sanitize(source.certificate || null);
    this.capabilities = capabilitySnapshot(options.capabilities || source.capabilities || sessionInfo.capabilities);
    this.home = asString(source.home || options.home || sessionInfo.home || '/');
    this.space = source.space === undefined ? null : sanitize(source.space);
    this.spaceError = asString(source.spaceError);
  }

  toJSON() {
    const out = {};
    for (const key of FILE_SYSTEM_SERIAL_FIELDS) if (this[key] !== undefined) out[key] = clone(this[key]);
    return out;
  }

  serialize() { return stableStringify(this.toJSON()); }
}

module.exports = {
  SESSION_INFO_VERSION,
  SESSION_STATUS,
  SESSION_STATUS_CODES,
  PROTOCOL_IDENTITIES,
  SERIAL_FIELDS,
  FILE_SYSTEM_SERIAL_FIELDS,
  stableStringify,
  endpoint,
  protocolIdentity,
  SessionInfo,
  FileSystemInfo,
  // C++-named aliases make the relationship obvious when porting a caller.
  TSessionInfo: SessionInfo,
  TFileSystemInfo: FileSystemInfo,
};
