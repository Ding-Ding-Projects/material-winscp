// putty.js — the safe metadata boundary for PuTTY interoperability.
//
// This module deliberately does not load, decrypt, or serialize private-key
// material.  It only validates the public shape of PuTTY .ppk files and the
// small, non-secret subset of PuTTY session settings that this app can use.
// Every parser returns { ok: true, value } or a generic { ok: false, error };
// malformed input never gets reflected into an error message.
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_LINES = 8192;
const MAX_BODY_LINES = 4096;
const MAX_TEXT_LENGTH = 4096;
const MAX_COMMENT_LENGTH = 1024;
const MAX_ARGON2_MEMORY_KIB = 1024 * 1024;
const MAX_ARGON2_PASSES = 1000000;
const MAX_ARGON2_PARALLELISM = 1024;
const MAX_ARGON2_SALT_HEX = 256;

const FAILURE = Object.freeze({ ok: false, error: 'Invalid PuTTY metadata.' });

const KEY_ALGORITHMS = Object.freeze([
  'ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ssh-dss',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'ssh-ed25519', 'ssh-ed448',
]);

const CIPHERS = Object.freeze([
  'aes', 'aesgcm', 'chacha20', '3des', 'blowfish', 'des', 'arcfour', 'WARN',
]);

const KEX_ALGORITHMS = Object.freeze([
  'ecdh', 'ntru-curve25519', 'mlkem-curve25519', 'mlkem-nist',
  'dh-gex-sha1', 'dh-group18-sha512', 'dh-group17-sha512',
  'dh-group16-sha512', 'dh-group15-sha512', 'dh-group14-sha1', 'rsa',
  'dh-group1-sha1', 'WARN',
]);

const HOST_KEY_ALGORITHMS = Object.freeze([
  'rsa', 'dsa', 'ecdsa', 'ed25519', 'ed448', 'WARN',
]);

const PROTOCOLS = Object.freeze(['ssh', 'telnet', 'rlogin', 'raw', 'serial']);

const ALGORITHM_ALIASES = Object.freeze({
  cipher: Object.freeze({
    'aes256-ctr': 'aes',
    'aes256-cbc': 'aes',
    'aes-gcm': 'aesgcm',
    '3des-cbc': '3des',
    warning: 'WARN',
    warn: 'WARN',
  }),
  kex: Object.freeze({
    'diffie-hellman-group1-sha1': 'dh-group1-sha1',
    'diffie-hellman-group14-sha1': 'dh-group14-sha1',
    'diffie-hellman-group15-sha512': 'dh-group15-sha512',
    'diffie-hellman-group16-sha512': 'dh-group16-sha512',
    'diffie-hellman-group17-sha512': 'dh-group17-sha512',
    'diffie-hellman-group18-sha512': 'dh-group18-sha512',
    'diffie-hellman-group-exchange-sha1': 'dh-gex-sha1',
    warning: 'WARN',
    warn: 'WARN',
  }),
  hostKey: Object.freeze({
    'ssh-rsa': 'rsa',
    'rsa-sha2-256': 'rsa',
    'rsa-sha2-512': 'rsa',
    'ssh-dss': 'dsa',
    'ecdsa-sha2-nistp256': 'ecdsa',
    'ecdsa-sha2-nistp384': 'ecdsa',
    'ecdsa-sha2-nistp521': 'ecdsa',
    'ssh-ed25519': 'ed25519',
    'ssh-ed448': 'ed448',
    warning: 'WARN',
    warn: 'WARN',
  }),
});

const SECRET_CONFIG_KEYS = new Set([
  'password', 'passphrase', 'passphrasefile', 'proxypassword',
  'privatekeydata', 'privatekeyblob', 'sshpassword', 'sshpassphrase',
]);

const CONFIG_FIELDS = Object.freeze({
  SessionName: { name: 'sessionName', type: 'text' },
  HostName: { name: 'hostName', type: 'hostname' },
  UserName: { name: 'userName', type: 'text' },
  PortNumber: { name: 'portNumber', type: 'port' },
  Protocol: { name: 'protocol', type: 'protocol' },
  Cipher: { name: 'cipher', type: 'cipherList' },
  KEX: { name: 'kex', type: 'kexList' },
  HostKey: { name: 'hostKey', type: 'hostKeyList' },
  PrivateKeyFile: { name: 'privateKeyFile', type: 'path' },
  PublicKeyFile: { name: 'publicKeyFile', type: 'path' },
  ProxyMethod: { name: 'proxyMethod', type: 'proxyMethod' },
  ProxyHost: { name: 'proxyHost', type: 'text' },
  ProxyPort: { name: 'proxyPort', type: 'port' },
  Compression: { name: 'compression', type: 'boolean' },
  AgentFwd: { name: 'agentForwarding', type: 'boolean' },
  TryAgent: { name: 'tryAgent', type: 'boolean' },
  SshNoUserAuth: { name: 'noUserAuth', type: 'boolean' },
  SshNoShell: { name: 'noShell', type: 'boolean' },
});

const CONFIG_KEY_NAMES = Object.freeze(Object.keys(CONFIG_FIELDS));
const PROXY_METHODS = Object.freeze(['none', 'socks4', 'socks5', 'http', 'telnet', 'cmd']);
const ARGON2_DERIVATIONS = Object.freeze(['Argon2d', 'Argon2i', 'Argon2id']);

function fail() { return FAILURE; }

function success(value) { return { ok: true, value }; }

function hasUnsafeText(value, maxLength = MAX_TEXT_LENGTH) {
  return typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value);
}

function asInputText(input) {
  if (Buffer.isBuffer(input)) {
    if (input.length > MAX_INPUT_BYTES) return null;
    const text = input.toString('utf8');
    return text.includes('\ufffd') ? null : text;
  }
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) return null;
  return input;
}

function normalizePuttyPath(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (!value || value.length > MAX_TEXT_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return null;

  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) return null;
    value = value.slice(1, -1).trim();
  } else if (value.includes('"')) {
    return null;
  }
  if (!value || /[;&|<>`]/u.test(value)) return null;
  // A real path may contain spaces, for example under Program Files. An
  // executable suffix followed by whitespace is the unquoted command-line
  // form, which this path-only API must refuse.
  if (!value.startsWith('"') && /\.(?:exe|com|bat|cmd)\s+\S/iu.test(value)) return null;
  // A path is a path, not a command line.  Reject unmatched environment
  // markers instead of guessing how an executable would expand them.
  const markers = value.match(/%/gu) || [];
  const variables = value.match(/%[A-Za-z_][A-Za-z0-9_]*%/gu) || [];
  if (markers.length !== variables.length * 2) return null;
  return path.win32.normalize(value);
}

function normalizePuttyAlgorithm(kind, input) {
  if (typeof input !== 'string' || !input.trim() || hasUnsafeText(input, 128)) return null;
  const token = input.trim().toLowerCase();
  const aliases = ALGORITHM_ALIASES[kind] || {};
  const candidate = aliases[token] || (token === 'warn' ? 'WARN' : token);
  const supported = kind === 'cipher' ? CIPHERS
    : kind === 'kex' ? KEX_ALGORITHMS
      : kind === 'hostKey' ? HOST_KEY_ALGORITHMS : null;
  return supported && supported.includes(candidate) ? candidate : null;
}

function normalizePuttyAlgorithmList(kind, input) {
  const pieces = Array.isArray(input)
    ? input
    : typeof input === 'string' && input.trim()
      ? input.trim().split(/[\s,;]+/u)
      : [];
  if (!pieces.length || pieces.length > 64) return null;
  const result = [];
  for (const piece of pieces) {
    const normalized = normalizePuttyAlgorithm(kind, piece);
    if (!normalized || result.includes(normalized)) return null;
    result.push(normalized);
  }
  return result;
}

function normalizeProtocol(input) {
  if (typeof input !== 'string' || hasUnsafeText(input, 32)) return null;
  const aliases = { ssh2: 'ssh', 'ssh-2': 'ssh', rlogin: 'rlogin', serial: 'serial' };
  const candidate = aliases[input.trim().toLowerCase()] || input.trim().toLowerCase();
  return PROTOCOLS.includes(candidate) ? candidate : null;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'yes', 'true', 'on'].includes(normalized)) return true;
  if (['0', 'no', 'false', 'off'].includes(normalized)) return false;
  return null;
}

function parsePort(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,5}$/u.test(text.trim())) return null;
  const port = Number(text.trim());
  return port >= 1 && port <= 65535 ? port : null;
}

function parseProxyMethod(value) {
  if (typeof value !== 'string' || hasUnsafeText(value, 32)) return null;
  const normalized = value.trim().toLowerCase();
  return PROXY_METHODS.includes(normalized) ? normalized : null;
}

function parseConfigValue(field, raw) {
  switch (field.type) {
    case 'text':
      return hasUnsafeText(raw) ? null : raw;
    case 'hostname':
      return hasUnsafeText(raw) || !raw.trim() || /\s/u.test(raw) ? null : raw.trim();
    case 'port':
      return parsePort(raw);
    case 'protocol':
      return normalizeProtocol(raw);
    case 'cipherList':
      return normalizePuttyAlgorithmList('cipher', raw);
    case 'kexList':
      return normalizePuttyAlgorithmList('kex', raw);
    case 'hostKeyList':
      return normalizePuttyAlgorithmList('hostKey', raw);
    case 'path':
      return normalizePuttyPath(raw);
    case 'proxyMethod':
      return parseProxyMethod(raw);
    case 'boolean':
      return parseBoolean(raw);
    default:
      return null;
  }
}

function parseConfigEntries(input) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input) && !Array.isArray(input)) {
    return Object.entries(input).map(([key, value]) => ({ key, value }));
  }
  const text = asInputText(input);
  if (text === null) return null;
  const lines = text.split(/\r?\n/u);
  if (lines.length > MAX_LINES) return null;
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    // PuTTY's raw settings are commonly emitted as one space-delimited
    // `Name=Value` stream. Split only at the start of a new assignment, so a
    // quoted path or an ordinary value containing `=` remains intact.
    const matches = [...trimmed.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9]*)=/gu)];
    if (!matches.length || matches[0].index !== 0) return null;
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const valueStart = match.index + match[0].length;
      const valueEnd = i + 1 < matches.length ? matches[i + 1].index : trimmed.length;
      entries.push({ key: match[1], value: trimmed.slice(valueStart, valueEnd).trim() });
    }
  }
  return entries;
}

function parsePuttyConfig(input) {
  const entries = parseConfigEntries(input);
  if (!entries || entries.length > 256) return fail();
  const values = {};
  const ignoredKeys = [];
  const redactedKeys = [];
  const seen = new Set();

  for (const entry of entries) {
    if (typeof entry.key !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/u.test(entry.key)) return fail();
    if (typeof entry.value !== 'string' && typeof entry.value !== 'number' && typeof entry.value !== 'boolean') return fail();
    const keyLower = entry.key.toLowerCase();
    if (SECRET_CONFIG_KEYS.has(keyLower) || /(?:password|passphrase|secret)$/u.test(keyLower)) {
      redactedKeys.push(entry.key);
      continue;
    }
    const field = CONFIG_FIELDS[entry.key];
    if (!field) {
      ignoredKeys.push(entry.key);
      continue;
    }
    if (seen.has(entry.key)) return fail();
    seen.add(entry.key);
    const value = parseConfigValue(field, entry.value);
    if (value === null) return fail();
    values[field.name] = value;
  }

  return success({
    values,
    ignoredKeys: [...new Set(ignoredKeys)].sort(),
    redactedKeys: [...new Set(redactedKeys)].sort(),
  });
}

function parsePpkBody(lines, count) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_BODY_LINES || lines.length !== count) return false;
  const joined = lines.join('');
  if (!joined || joined.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(joined)) {
    return false;
  }
  return Buffer.from(joined, 'base64').length > 0;
}

function parsePpkCount(value) {
  if (!/^\d{1,4}$/u.test(value)) return null;
  const count = Number(value);
  return count >= 1 && count <= MAX_BODY_LINES ? count : null;
}

function parsePpkUint(value, max) {
  if (!/^\d{1,10}$/u.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= max ? parsed : null;
}

function parsePpkSalt(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > MAX_ARGON2_SALT_HEX ||
      value.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(value)) return null;
  return value.toLowerCase();
}

function nextPpkHeader(lines, state, expected) {
  if (state.index >= lines.length) return null;
  const line = lines[state.index++];
  const match = /^([A-Za-z][A-Za-z0-9-]*): ([^\r\n]*)$/u.exec(line);
  if (!match || match[1] !== expected || hasUnsafeText(match[2], MAX_TEXT_LENGTH)) return null;
  return match[2];
}

function parsePuttyKeyMetadata(input, options = {}) {
  const text = asInputText(input);
  if (text === null || text.includes('\u0000')) return fail();
  const lines = text.split(/\r?\n/u);
  if (lines.length > MAX_LINES) return fail();
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const state = { index: 0 };

  const first = state.index < lines.length ? lines[state.index++] : null;
  const header = first && /^PuTTY-User-Key-File-([23]): ([^\r\n]+)$/u.exec(first);
  if (!header || !KEY_ALGORITHMS.includes(header[2])) return fail();
  const version = Number(header[1]);
  const encryption = nextPpkHeader(lines, state, 'Encryption');
  if (!encryption || !['none', 'aes256-cbc'].includes(encryption)) return fail();
  const comment = nextPpkHeader(lines, state, 'Comment');
  if (comment === null || comment.length > MAX_COMMENT_LENGTH) return fail();
  const publicCountText = nextPpkHeader(lines, state, 'Public-Lines');
  const publicCount = publicCountText === null ? null : parsePpkCount(publicCountText);
  if (publicCount === null) return fail();
  const publicLines = lines.slice(state.index, state.index + publicCount);
  state.index += publicCount;
  if (!parsePpkBody(publicLines, publicCount)) return fail();

  // PPK v3 encrypted keys insert an Argon2 parameter block between the public
  // and private blobs. We validate its shape and bounds, but deliberately do
  // not derive a key or inspect the private blob. That keeps this path useful
  // for preflight and UI metadata without turning a file picker into a KDF
  // oracle or a denial-of-service primitive.
  let keyDerivation = null;
  if (version === 3 && encryption !== 'none') {
    const derivation = nextPpkHeader(lines, state, 'Key-Derivation');
    const memoryText = nextPpkHeader(lines, state, 'Argon2-Memory');
    const passesText = nextPpkHeader(lines, state, 'Argon2-Passes');
    const parallelismText = nextPpkHeader(lines, state, 'Argon2-Parallelism');
    const saltText = nextPpkHeader(lines, state, 'Argon2-Salt');
    const memory = memoryText === null ? null : parsePpkUint(memoryText, MAX_ARGON2_MEMORY_KIB);
    const passes = passesText === null ? null : parsePpkUint(passesText, MAX_ARGON2_PASSES);
    const parallelism = parallelismText === null ? null : parsePpkUint(parallelismText, MAX_ARGON2_PARALLELISM);
    const salt = saltText === null ? null : parsePpkSalt(saltText);
    if (!derivation || !ARGON2_DERIVATIONS.includes(derivation) ||
        memory === null || passes === null || parallelism === null || salt === null) return fail();
    keyDerivation = { algorithm: derivation, memoryKiB: memory, passes, parallelism, salt };
  }

  const privateCountText = nextPpkHeader(lines, state, 'Private-Lines');
  const privateCount = privateCountText === null ? null : parsePpkCount(privateCountText);
  if (privateCount === null) return fail();
  const privateLines = lines.slice(state.index, state.index + privateCount);
  state.index += privateCount;
  if (!parsePpkBody(privateLines, privateCount)) return fail();
  const privateMac = nextPpkHeader(lines, state, 'Private-MAC');
  const expectedMacLength = version === 3 ? 64 : 40;
  if (privateMac === null || privateMac.length !== expectedMacLength ||
      !/^[0-9a-f]+$/iu.test(privateMac)) return fail();
  if (state.index !== lines.length) return fail();

  let filePath = '';
  if (options.filePath !== undefined) {
    filePath = normalizePuttyPath(options.filePath);
    if (!filePath) return fail();
  }
  const value = {
    format: 'ppk',
    version,
    algorithm: header[2],
    encryption,
    encrypted: encryption !== 'none',
    comment,
    publicLineCount: publicCount,
    privateLineCount: privateCount,
    hasPrivateMaterial: true,
    hasPrivateMac: true,
    filePath,
  };
  if (keyDerivation) value.keyDerivation = keyDerivation;
  return success(value);
}

function readPuttyKeyMetadata(filePath) {
  const normalized = normalizePuttyPath(filePath);
  if (!normalized) return fail();
  try {
    const stat = fs.statSync(normalized);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) return fail();
    return parsePuttyKeyMetadata(fs.readFileSync(normalized), { filePath: normalized });
  } catch {
    return fail();
  }
}

module.exports = {
  MAX_INPUT_BYTES,
  KEY_ALGORITHMS,
  CIPHERS,
  KEX_ALGORITHMS,
  HOST_KEY_ALGORITHMS,
  PROTOCOLS,
  ARGON2_DERIVATIONS,
  normalizePuttyPath,
  normalizePuttyAlgorithm,
  normalizePuttyAlgorithmList,
  parsePuttyConfig,
  parsePuttyKeyMetadata,
  readPuttyKeyMetadata,
};
