// ui/dialogs/importsessions.js — Import sites (ImportSessions.dfm).
//
// Six sources, each with its own real parser: a PuTTY registry export, the
// same format from KiTTY, FileZilla's sitemanager.xml, an OpenSSH client
// config, a WinSCP INI file, and an OpenSSH known_hosts file.
//
// Everything is parsed HERE, in the renderer, from text the user supplied.
// That has two consequences worth stating:
//
//   * No DOM. The XML reader below is hand-written rather than DOMParser,
//     because these parsers have to run in test/sitedata.test.js under plain
//     Node, and because a hand-written reader has no entity-expansion or
//     external-DTD surface at all.
//   * Bounded. Every parser caps its input and its output, so a 40 MB registry
//     dump cannot lock the window up.
//
// Passwords found in an import are carried to main through the site record and
// are never logged, never echoed into the list, and never shown in the preview:
// the list says "password included" and nothing more.
//
// Reference: vendor/winscp/source/forms/ImportSessions.dfm and
// vendor/winscp/source/core/SessionData.cpp (ImportFromFilezilla,
// ImportFromOpenssh, ImportFromKnownHosts, TSessionData::DoLoad).

import { h, icon, clear, uid, appearanceTarget, announce, pickTextFile } from '../../dom.js';
import { t } from '../../i18n.js';
import { api } from '../../state.js';
import { registerDialog, openDialog } from '../../app.js';
import { notify } from '../notifications.js';
import { createSearchBar, filterBy, noMatchMessage } from '../searchbar.js';
import {
  SESSION_DEFAULTS, siteStore, notifySitesChanged, installSessionDialogStyles,
  defaultPortFor, protocolInfo, ANONYMOUS_USER, ANONYMOUS_PASSWORD, s,
} from './sitetree.js';

/** Guard rails. An import file is user-supplied data, not a trusted format. */
const MAX_INPUT = 8 * 1024 * 1024;      // characters
const MAX_SITES = 5000;

/* ================================================================== */
/* shared helpers                                                      */
/* ================================================================== */

function guard(text) {
  const s = String(text ?? '');
  if (s.length > MAX_INPUT) {
    throw new Error(`The file is too large to import (${Math.round(s.length / 1048576)} MB; the limit is ${MAX_INPUT / 1048576} MB).`);
  }
  return s;
}

/** A site record built from an imported one, with every default filled in. */
function importedSite(fields, { source, name, folder = '' }) {
  const protocol = protocolInfo(fields.protocol || 'sftp').id;
  const site = {
    ...SESSION_DEFAULTS,
    ...fields,
    protocol,
    name: String(name || fields.name || fields.hostName || '').slice(0, 256),
    folder: String(folder || fields.folder || ''),
  };
  if (!site.portNumber) site.portNumber = defaultPortFor(protocol, site.ftps);
  if (site.password) site.savePassword = true;
  // The record the dialog shows and the record it writes are the same object
  // minus the bookkeeping, so the preview can never disagree with the result.
  return { site, source, hasPassword: !!site.password, warnings: fields.__warnings || [] };
}

/* ================================================================== */
/* PuTTY / KiTTY registry export                                       */
/* ================================================================== */

/**
 * Decode one .reg value. Handles the three forms a PuTTY session actually
 * uses: a quoted string with backslash escapes, `dword:` and `hex(2):`
 * (an expandable string, stored as UTF-16LE bytes).
 */
export function decodeRegValue(raw) {
  const value = String(raw ?? '').trim();
  if (value.startsWith('"')) {
    // Strip the quotes, then undo \\ and \" — in that order, or a trailing
    // backslash before a quote unescapes the wrong character.
    const inner = value.slice(1, value.lastIndexOf('"') > 0 ? value.lastIndexOf('"') : undefined);
    let out = '';
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i] === '\\' && i + 1 < inner.length) { out += inner[i + 1]; i += 1; }
      else out += inner[i];
    }
    return { kind: 'string', value: out };
  }
  const dword = /^dword:([0-9a-f]{1,8})$/i.exec(value);
  if (dword) return { kind: 'number', value: Number.parseInt(dword[1], 16) };
  const hex = /^hex(?:\(([0-9a-f])\))?:([0-9a-f, \\\r\n]*)$/i.exec(value);
  if (hex) {
    const bytes = hex[2].split(',').map((b) => Number.parseInt(b.trim(), 16)).filter((n) => Number.isFinite(n));
    const type = hex[1] ? Number.parseInt(hex[1], 16) : 3;
    if (type === 2 || type === 1) {
      // REG_SZ / REG_EXPAND_SZ are UTF-16LE with a trailing NUL.
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = bytes[i] | (bytes[i + 1] << 8);
        if (code === 0) break;
        out += String.fromCharCode(code);
      }
      return { kind: 'string', value: out };
    }
    return { kind: 'binary', value: bytes };
  }
  return { kind: 'string', value };
}

/**
 * PuTTY/WinSCP encode session names as URL-style UTF-8 bytes. This mirrors
 * vendor/winscp/source/core/Common.cpp's DecodeUrlChars: '+' is a space and a
 * consecutive run of %XX values is decoded as one UTF-8 string. Decoding each
 * byte as a JavaScript character turns names such as 香港 into mojibake.
 * Invalid runs stay escaped so a damaged registry export never throws or
 * silently invents a different site name.
 */
export function decodePuttySessionName(name) {
  const encoded = String(name ?? '');
  let decoded = '';
  let index = 0;

  while (index < encoded.length) {
    if (encoded[index] === '+') {
      decoded += ' ';
      index += 1;
      continue;
    }

    const first = encoded.slice(index, index + 3);
    if (first.length !== 3 || first[0] !== '%' || !/^[0-9A-Fa-f]{2}$/u.test(first.slice(1))) {
      decoded += encoded[index];
      index += 1;
      continue;
    }

    const start = index;
    const bytes = [];
    while (index + 2 < encoded.length && encoded[index] === '%') {
      const hex = encoded.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/u.test(hex)) break;
      bytes.push(Number.parseInt(hex, 16));
      index += 3;
    }

    const escapedRun = encoded.slice(start, index);
    try {
      if (typeof TextDecoder === 'function') {
        decoded += new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
      } else {
        decoded += decodeURIComponent(escapedRun);
      }
    } catch {
      decoded += escapedRun;
    }
  }

  return decoded;
}

/**
 * PuTTY writes HKCU\Software\SimonTatham\PuTTY\Sessions\<name> and KiTTY
 * writes HKCU\Software\9bis.com\KiTTY\Sessions\<name>, so the vendor segment
 * differs but the last two are always <product>\Sessions. Matching on those
 * accepts both without also swallowing SshHostKeys or Jumplist.
 */
const PUTTY_SESSION_KEY = /\\(?:PuTTY|KiTTY)\\Sessions\\(.+)$/i;

/** PuTTY's TProxyMethod numbering, shared with WinSCP (core/SessionData.h). */
const PROXY_METHODS = ['none', 'socks4', 'socks5', 'http', 'telnet', 'cmd', 'sshTcpIp'];

/**
 * parsePuttyRegistry(text) -> imported[]
 * Reads a `regedit /e` export of HKCU\Software\SimonTatham\PuTTY\Sessions
 * (and KiTTY's equivalent key, which uses the identical value names).
 */
export function parsePuttyRegistry(text, { source = 'putty' } = {}) {
  const lines = guard(text).split(/\r?\n/);
  const sessions = [];
  let current = null;

  // .reg wraps long values with a trailing backslash; rejoin before parsing.
  const joined = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    while (/\\\s*$/.test(line) && i + 1 < lines.length) {
      line = line.replace(/\\\s*$/, '') + lines[i + 1].trim();
      i += 1;
    }
    joined.push(line);
  }

  for (const line of joined) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;
    if (trimmed.startsWith('[')) {
      const key = trimmed.replace(/^\[-?/, '').replace(/\]$/, '');
      const match = PUTTY_SESSION_KEY.exec(key);
      current = match ? { name: decodePuttySessionName(match[1]), values: new Map() } : null;
      if (current) sessions.push(current);
      continue;
    }
    if (!current) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const rawName = trimmed.slice(0, eq).trim();
    const name = rawName === '@' ? '' : rawName.replace(/^"|"$/g, '');
    current.values.set(name, decodeRegValue(trimmed.slice(eq + 1)));
  }

  return sessions.slice(0, MAX_SITES).map((session) => {
    const get = (key, fallback) => (session.values.has(key) ? session.values.get(key).value : fallback);
    const bool = (key, fallback) => (session.values.has(key) ? !!session.values.get(key).value : fallback);
    const warnings = [];

    const puttyProtocol = String(get('Protocol', 'ssh')).toLowerCase();
    if (puttyProtocol && puttyProtocol !== 'ssh') {
      warnings.push(`PuTTY stored this session as "${puttyProtocol}", which carries no file transfer. It is imported as SFTP; change the protocol if that is wrong.`);
    }

    // PuTTY allows user@host in HostName; WinSCP splits it, so we do too.
    let hostName = String(get('HostName', ''));
    let userName = String(get('UserName', ''));
    const at = hostName.lastIndexOf('@');
    if (at > 0 && !userName) { userName = hostName.slice(0, at); hostName = hostName.slice(at + 1); }

    const fields = {
      hostName,
      userName,
      portNumber: Number(get('PortNumber', 22)) || 22,
      protocol: 'sftp',
      puttyProtocol,
      compression: bool('Compression', false),
      publicKeyFile: String(get('PublicKeyFile', '')),
      detachedCertificate: String(get('DetachedCertificate', '')),
      agentFwd: bool('AgentFwd', false),
      tryAgent: bool('TryAgent', true),
      authKI: bool('AuthKI', true),
      authKIPassword: bool('AuthKIPassword', true),
      authGSSAPI: bool('AuthGSSAPI', bool('AuthSSPI', false)),
      authGSSAPIKEX: bool('AuthGSSAPIKEX', false),
      gssapiFwdTGT: bool('GSSAPIFwdTGT', bool('GssapiFwd', bool('SSPIFwdTGT', false))),
      timeout: Number(get('ConnectionTimeout', 15)) || 15,
      pingInterval: Number(get('PingInterval', 0)) * 60 + Number(get('PingIntervalSecs', 0)),
      addressFamily: Number(get('AddressFamily', 0)) === 1 ? 'ipv4' : Number(get('AddressFamily', 0)) === 2 ? 'ipv6' : 'auto',
      sourceAddress: String(get('LogicalHostName', '')),
      rekeyTime: Number(get('RekeyTime', 60)),
      rekeyData: String(get('RekeyBytes', '1G')),
      sshNoUserAuth: bool('SshNoAuth', false),
      __warnings: warnings,
    };
    if (!fields.pingInterval) fields.pingInterval = 30;

    const proxyIndex = Number(get('ProxyMethod', 0)) || 0;
    const proxyMethod = PROXY_METHODS[proxyIndex] || 'none';
    if (proxyMethod === 'sshTcpIp') {
      // PuTTY's "SSH TCP/IP" proxy is what WinSCP calls a tunnel.
      fields.tunnel = true;
      fields.tunnelHostName = String(get('ProxyHost', ''));
      fields.tunnelPortNumber = Number(get('ProxyPort', 22)) || 22;
      fields.tunnelUserName = String(get('ProxyUsername', ''));
    } else if (proxyMethod !== 'none') {
      fields.proxyMethod = proxyMethod;
      fields.proxyHost = String(get('ProxyHost', ''));
      fields.proxyPort = Number(get('ProxyPort', 0)) || 0;
      fields.proxyUsername = String(get('ProxyUsername', ''));
      fields.proxyTelnetCommand = String(get('ProxyTelnetCommand', SESSION_DEFAULTS.proxyTelnetCommand));
      fields.proxyLocalCommand = String(get('ProxyLocalCommand', ''));
      fields.proxyDNS = ['auto', 'off', 'on'][Number(get('ProxyDNS', 1))] || 'auto';
      fields.proxyLocalhost = bool('ProxyLocalhost', false);
    }

    const cipherOrder = String(get('Cipher', ''));
    if (cipherOrder) fields.cipherList = cipherOrder.split(',').map((s) => s.trim()).filter(Boolean);
    const kexOrder = String(get('KEX', ''));
    if (kexOrder) fields.kexList = kexOrder.split(',').map((s) => s.trim()).filter(Boolean);
    const hostKeyOrder = String(get('HostKey', ''));
    if (hostKeyOrder) fields.hostKeyList = hostKeyOrder.split(',').map((s) => s.trim()).filter(Boolean);
    const gssOrder = String(get('GSSLibs', ''));
    if (gssOrder) fields.gssLibList = gssOrder.split(',').map((s) => s.trim()).filter(Boolean);

    return importedSite(fields, { source, name: session.name });
  }).filter((entry) => !!entry.site.hostName);
}

/* ================================================================== */
/* a minimal XML reader (FileZilla)                                    */
/* ================================================================== */

/**
 * Parse XML into { name, attrs, children, text }. Deliberately small: it
 * understands elements, attributes, text, CDATA, comments and the five
 * predefined entities plus numeric ones. It understands NO doctype, NO entity
 * declarations and NO external references, so an imported file cannot make it
 * fetch or expand anything.
 */
export function parseXml(text) {
  const src = guard(text);
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;

  const decodeEntities = (s) => String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? Number.parseInt(ent.slice(2), 16)
        : Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[ent] ?? m;
  });

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { stack[stack.length - 1].text += decodeEntities(src.slice(i)); break; }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) { const end = src.indexOf('-->', lt); i = end < 0 ? src.length : end + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      stack[stack.length - 1].text += src.slice(lt + 9, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }

    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    const raw = src.slice(lt + 1, gt).trim();

    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const space = body.search(/\s/);
    const name = space < 0 ? body : body.slice(0, space);
    const attrs = {};
    if (space >= 0) {
      const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m;
      while ((m = attrRe.exec(body.slice(space))) !== null) {
        attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4] || '');
      }
    }
    const node = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
}

/** First direct child with this name, case-insensitively. */
export function xmlChild(node, name) {
  if (!node) return null;
  const lower = String(name).toLowerCase();
  return node.children.find((c) => c.name.toLowerCase() === lower) || null;
}
export function xmlChildren(node, name) {
  if (!node) return [];
  const lower = String(name).toLowerCase();
  return node.children.filter((c) => c.name.toLowerCase() === lower);
}
function xmlText(node, name, fallback = '') {
  const child = xmlChild(node, name);
  return child ? child.text.trim() : fallback;
}

/** base64 without Node's Buffer or the browser's atob differing on padding. */
export function decodeBase64Utf8(input) {
  const clean = String(input || '').replace(/\s+/g, '');
  if (!clean) return '';
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === '=') break;
    const v = table.indexOf(ch);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); }
  }
  // UTF-8 decode by hand: TextDecoder exists in both runtimes but takes a
  // typed array, and building one here keeps the function dependency-free.
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
    else if (b < 0xe0) { out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else {
      const code = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(code);
      i += 4;
    }
  }
  return out;
}

/** FileZilla's ServerProtocol enum, as ImportFromFilezilla reads it. */
const FZ_PROTOCOL = {
  0: { protocol: 'ftp', ftps: 'none' },
  1: { protocol: 'sftp', ftps: 'none' },
  3: { protocol: 'ftp', ftps: 'implicit' },
  4: { protocol: 'ftp', ftps: 'explicitTls' },
};

/**
 * FileZilla stores RemoteDir as a length-prefixed segment list:
 * "1 0 3 pub 4 test" — a type, a prefix length, then <len> <segment> pairs.
 */
export function decodeFileZillaRemoteDir(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter((s) => s !== '');
  if (parts.length < 2) return '';
  let index = 1;                                   // [0] is the server type
  const prefixSize = Number.parseInt(parts[index], 10) || 0;
  index += 1;
  if (prefixSize > 0) index += 1;                  // skip the prefix token
  const segments = [];
  while (index < parts.length) {
    const len = Number.parseInt(parts[index], 10);
    index += 1;
    if (!Number.isFinite(len) || len <= 0) break;
    // A segment may itself contain spaces, so re-join by character length.
    let segment = '';
    while (index < parts.length && segment.length < len) {
      segment = segment ? `${segment} ${parts[index]}` : parts[index];
      index += 1;
    }
    if (segment) segments.push(segment);
  }
  return segments.length ? `/${segments.join('/')}` : '/';
}

/** parseFileZillaXml(text) -> imported[] — reads sitemanager.xml. */
export function parseFileZillaXml(text, { source = 'filezilla' } = {}) {
  const doc = parseXml(text);
  const fz = xmlChild(doc, 'FileZilla3');
  if (!fz) throw new Error('This does not look like a FileZilla site manager file: there is no <FileZilla3> element.');
  const servers = xmlChild(fz, 'Servers');
  if (!servers) return [];

  const out = [];
  const walk = (node, path) => {
    for (const child of node.children) {
      const name = child.name.toLowerCase();
      if (name === 'folder') {
        // A folder's own name is its leading text node.
        const folderName = String(child.text || '').trim().split('\n')[0].trim() || 'Folder';
        walk(child, path ? `${path}/${folderName}` : folderName);
      } else if (name === 'server') {
        if (out.length >= MAX_SITES) return;
        out.push(readFileZillaServer(child, path, source));
      }
    }
  };
  walk(servers, '');
  return out.filter((entry) => !!entry.site.hostName);
}

function readFileZillaServer(node, folder, source) {
  const warnings = [];
  const protocolIndex = Number.parseInt(xmlText(node, 'Protocol', '0'), 10);
  const mapped = FZ_PROTOCOL[protocolIndex];
  if (!mapped) warnings.push(`FileZilla protocol ${protocolIndex} has no equivalent here; imported as plain FTP.`);
  const { protocol, ftps } = mapped || { protocol: 'ftp', ftps: 'none' };

  const fields = { protocol, ftps, __warnings: warnings };
  fields.hostName = xmlText(node, 'Host');
  fields.portNumber = Number.parseInt(xmlText(node, 'Port', ''), 10) || defaultPortFor(protocol, ftps);

  const logonType = Number.parseInt(xmlText(node, 'Logontype', '0'), 10);
  if (logonType === 0) {
    fields.userName = ANONYMOUS_USER;
    fields.password = ANONYMOUS_PASSWORD;
    fields.anonymous = true;
  } else {
    fields.userName = xmlText(node, 'User');
    fields.ftpAccount = xmlText(node, 'Account');
    const passNode = xmlChild(node, 'Pass');
    if (passNode) {
      const encoding = String(passNode.attrs.encoding || '').toLowerCase();
      fields.password = encoding === 'base64' ? decodeBase64Utf8(passNode.text.trim()) : passNode.text.trim();
    }
    if (logonType === 4 || logonType === 5) {
      warnings.push('FileZilla stores this site’s password in its own credential store, so no password came across. Enter it after importing.');
      fields.password = '';
    }
  }

  fields.publicKeyFile = xmlText(node, 'Keyfile');
  fields.note = xmlText(node, 'Comments');
  fields.localDirectory = xmlText(node, 'LocalDir');
  const remote = decodeFileZillaRemoteDir(xmlText(node, 'RemoteDir'));
  if (remote) fields.remoteDirectory = remote;
  fields.synchronizeBrowsing = xmlText(node, 'SyncBrowsing', '0') !== '0';

  const timezoneOffset = Number.parseInt(xmlText(node, 'TimezoneOffset', '0'), 10) || 0;
  fields.timeDifference = timezoneOffset / 60;
  fields.timeDifferenceAuto = timezoneOffset === 0;

  const pasv = xmlText(node, 'PasvMode').toUpperCase();
  if (pasv === 'MODE_PASSIVE') fields.ftpPasvMode = true;
  else if (pasv === 'MODE_ACTIVE') fields.ftpPasvMode = false;

  const encodingType = xmlText(node, 'EncodingType');
  if (/^auto$/i.test(encodingType)) fields.utf = 'auto';
  else if (/^utf-?8$/i.test(encodingType)) fields.utf = 'on';

  return importedSite(fields, { source, name: xmlText(node, 'Name') || fields.hostName, folder });
}

/* ================================================================== */
/* OpenSSH client config                                               */
/* ================================================================== */

/** OpenSSH treats yes/no case-insensitively and ignores everything else. */
function opensshBool(value) { return /^yes$/i.test(String(value || '').trim()); }

/**
 * Split an OpenSSH config line into a directive and its arguments. OpenSSH
 * accepts `Key value`, `Key=value` and quoted arguments.
 */
export function parseOpensshDirective(line) {
  const trimmed = String(line || '').replace(/^﻿/, '').trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*(?:=|\s)\s*(.*)$/.exec(trimmed);
  if (!m) return null;
  return { directive: m[1], args: m[2].trim() };
}

/** One token, honouring double quotes, then the remainder. */
function cutOpensshToken(args) {
  const s = String(args || '').trim();
  if (!s) return ['', ''];
  if (s[0] === '"') {
    const end = s.indexOf('"', 1);
    if (end < 0) return [s.slice(1), ''];
    return [s.slice(1, end), s.slice(end + 1).trim()];
  }
  const space = s.search(/\s/);
  return space < 0 ? [s, ''] : [s.slice(0, space), s.slice(space).trim()];
}

/** `~/…` is meaningless on Windows; WinSCP rewrites it the same way. */
function convertPathFromOpenssh(p) {
  const s = String(p || '');
  return s.startsWith('~/') ? `%USERPROFILE%\\${s.slice(2).replace(/\//g, '\\')}` : s;
}

/**
 * parseOpenSshConfig(text) -> imported[]
 *
 * One imported site per `Host` pattern that is a literal name (a pattern with
 * a wildcard configures other hosts rather than being one). Each site collects
 * the directives from its own block plus the global ones above it, first
 * occurrence winning, exactly as OpenSSH resolves them.
 */
export function parseOpenSshConfig(text, { source = 'openssh' } = {}) {
  const lines = guard(text).split(/\r?\n/);

  const blocks = [];                                  // { patterns[], entries[] }
  let current = { patterns: ['*'], entries: [] };
  blocks.push(current);
  for (const line of lines) {
    const parsed = parseOpensshDirective(line);
    if (!parsed) continue;
    if (/^host$/i.test(parsed.directive)) {
      const patterns = [];
      let rest = parsed.args;
      while (rest) { const [token, remainder] = cutOpensshToken(rest); if (token) patterns.push(token); rest = remainder; }
      current = { patterns, entries: [] };
      blocks.push(current);
    } else if (/^match$/i.test(parsed.directive)) {
      // A Match block applies conditionally at connect time; importing it as
      // a site would silently apply settings the user never asked for.
      current = { patterns: [], entries: [] };
      blocks.push(current);
    } else {
      current.entries.push(parsed);
    }
  }

  const globals = blocks.filter((b) => b.patterns.includes('*')).flatMap((b) => b.entries);
  const out = [];

  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (pattern === '*' || pattern.includes('*') || pattern.includes('?') || pattern.startsWith('!')) continue;
      if (out.length >= MAX_SITES) break;
      const fields = { protocol: 'sftp', hostName: pattern, portNumber: 22, __warnings: [] };
      const used = new Set();
      for (const { directive, args } of [...block.entries, ...globals]) {
        const key = directive.toLowerCase();
        if (used.has(key)) continue;
        const [value, remainder] = cutOpensshToken(args);
        if (remainder) continue;                     // every directive we read takes one token
        if (!applyOpensshDirective(fields, key, value, blocks)) continue;
        used.add(key);
      }
      out.push(importedSite(fields, { source, name: pattern }));
    }
  }
  return out;
}

function applyOpensshDirective(fields, key, value, blocks) {
  switch (key) {
    case 'hostname': fields.hostName = value; return true;
    case 'port': fields.portNumber = Number.parseInt(value, 10) || 22; return true;
    case 'user': fields.userName = value; return true;
    case 'identityfile': fields.publicKeyFile = convertPathFromOpenssh(value); return true;
    case 'certificatefile': fields.detachedCertificate = convertPathFromOpenssh(value); return true;
    case 'compression': fields.compression = opensshBool(value); return true;
    case 'forwardagent': fields.agentFwd = opensshBool(value); return true;
    case 'gssapiauthentication': fields.authGSSAPI = opensshBool(value); return true;
    case 'gssapidelegatecredentials': fields.authGSSAPIKEX = opensshBool(value); return true;
    case 'kbdinteractiveauthentication': fields.authKI = opensshBool(value); return true;
    case 'bindaddress': fields.sourceAddress = value; return true;
    case 'addressfamily':
      fields.addressFamily = /^inet$/i.test(value) ? 'ipv4' : /^inet6$/i.test(value) ? 'ipv6' : 'auto';
      return true;
    case 'serveraliveinterval': {
      const seconds = Number.parseInt(value, 10) || 0;
      if (seconds > 0) { fields.pingInterval = seconds; fields.pingType = 'dummy'; }
      return true;
    }
    case 'connecttimeout': fields.timeout = Number.parseInt(value, 10) || 15; return true;
    case 'proxyjump': {
      // Multiple hops cannot be expressed as one tunnel, so they are reported
      // rather than half-applied.
      if (value.includes(',')) {
        fields.__warnings.push(`ProxyJump "${value}" has more than one hop; only a single tunnel host can be imported.`);
        return true;
      }
      const jump = parseJumpHost(value, blocks);
      fields.tunnel = true;
      fields.tunnelHostName = jump.hostName;
      fields.tunnelPortNumber = jump.portNumber;
      fields.tunnelUserName = jump.userName;
      if (jump.publicKeyFile) fields.tunnelPublicKeyFile = jump.publicKeyFile;
      return true;
    }
    default: return false;
  }
}

/** `[user@]host[:port]`, resolved against the config's own Host blocks. */
function parseJumpHost(spec, blocks) {
  let rest = String(spec || '');
  let userName = '';
  const at = rest.lastIndexOf('@');
  if (at > 0) { userName = rest.slice(0, at); rest = rest.slice(at + 1); }
  let portNumber = 22;
  const colon = rest.lastIndexOf(':');
  if (colon > 0 && !rest.includes(']')) {
    const port = Number.parseInt(rest.slice(colon + 1), 10);
    if (Number.isFinite(port)) { portNumber = port; rest = rest.slice(0, colon); }
  }
  const out = { hostName: rest, userName, portNumber, publicKeyFile: '' };
  // A jump host named by an alias inherits that alias's own block.
  for (const block of blocks) {
    if (!block.patterns.includes(rest)) continue;
    for (const { directive, args } of block.entries) {
      const [value] = cutOpensshToken(args);
      const key = directive.toLowerCase();
      if (key === 'hostname') out.hostName = value;
      else if (key === 'port') out.portNumber = Number.parseInt(value, 10) || out.portNumber;
      else if (key === 'user' && !out.userName) out.userName = value;
      else if (key === 'identityfile') out.publicKeyFile = convertPathFromOpenssh(value);
    }
  }
  return out;
}

/* ================================================================== */
/* WinSCP INI                                                          */
/* ================================================================== */

/** INI escaping: WinSCP percent-encodes awkward characters in a section name. */
function decodeIniName(name) {
  return String(name || '')
    .replace(/%([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** The FSProtocol integers WinSCP writes, mapped onto this port's names. */
const INI_FS_PROTOCOL = { 0: 'scp', 1: 'sftp', 2: 'sftp', 3: 'ftp', 4: 'webdav', 5: 's3' };
const INI_FTPS = { 0: 'none', 1: 'implicit', 3: 'explicitTls', 2: 'explicitTls' };

/** Session keys whose INI value is an integer index into a named list. */
const INI_AUTOSWITCH = ['auto', 'off', 'on'];

/**
 * parseWinScpIni(text) -> imported[]
 *
 * Reads `[Sessions\<name>]` sections out of a WinSCP.ini. The section name
 * carries the folder path, so "Work/Prod" arrives as a folder plus a site.
 * Only stored (`PasswordPlain`) passwords come across: an encrypted
 * `Password=` value is bound to the machine that wrote it, so it is reported
 * rather than imported as gibberish.
 */
export function parseWinScpIni(text, { source = 'ini' } = {}) {
  const lines = guard(text).split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const name = trimmed.slice(1, -1);
      const m = /^Sessions\\(.+)$/i.exec(name);
      current = m ? { name: decodeIniName(m[1]), values: new Map() } : null;
      if (current) sections.push(current);
      continue;
    }
    if (!current) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    current.values.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
  }

  return sections.slice(0, MAX_SITES).map((section) => {
    const v = section.values;
    const str = (key, fallback = '') => (v.has(key) ? v.get(key) : fallback);
    const int = (key, fallback = 0) => (v.has(key) ? (Number.parseInt(v.get(key), 10) || 0) : fallback);
    const bool = (key, fallback = false) => (v.has(key) ? v.get(key) !== '0' : fallback);
    const warnings = [];

    const protocol = INI_FS_PROTOCOL[int('FSProtocol', 1)] || 'sftp';
    const ftps = INI_FTPS[int('Ftps', 0)] || 'none';
    const fields = {
      protocol,
      ftps,
      hostName: str('HostName'),
      userName: str('UserName'),
      portNumber: int('PortNumber', defaultPortFor(protocol, ftps)),
      note: str('Note'),
      publicKeyFile: str('PublicKeyFile'),
      hostKey: str('SshHostKey', str('HostKey')),
      compression: bool('Compression'),
      timeout: int('Timeout', 15),
      pingInterval: int('PingInterval', 0) * 60 + int('PingIntervalSecs', int('PingIntervalSec', 30)),
      pingType: ['off', 'null', 'dummy'][int('PingType', 0)] || 'off',
      addressFamily: ['auto', 'ipv4', 'ipv6'][int('AddressFamily', 0)] || 'auto',
      localDirectory: str('LocalDirectory'),
      remoteDirectory: str('RemoteDirectory'),
      ftpPasvMode: bool('FtpPasvMode', true),
      ftpAccount: str('FtpAccount'),
      tunnel: bool('Tunnel'),
      tunnelHostName: str('TunnelHostName'),
      tunnelPortNumber: int('TunnelPortNumber', 22),
      tunnelUserName: str('TunnelUserName'),
      proxyMethod: PROXY_METHODS[int('ProxyMethod', 0)] || 'none',
      proxyHost: str('ProxyHost'),
      proxyPort: int('ProxyPort', 0),
      proxyUsername: str('ProxyUsername'),
      s3DefaultRegion: str('S3DefaultRegion'),
      utf: INI_AUTOSWITCH[int('Utf', 0)] || 'auto',
      __warnings: warnings,
    };
    if (fields.proxyMethod === 'sshTcpIp') fields.proxyMethod = 'none';

    if (v.has('PasswordPlain')) fields.password = str('PasswordPlain');
    else if (v.has('Password')) {
      warnings.push('The stored password is encrypted against the machine that wrote this file, so it cannot be imported. Enter it after importing.');
    }

    const cipher = str('Cipher');
    if (cipher) fields.cipherList = cipher.split(',').map((s) => s.trim()).filter(Boolean);
    const kex = str('KEX');
    if (kex) fields.kexList = kex.split(',').map((s) => s.trim()).filter(Boolean);
    const hostKeyList = str('HostKey2');
    if (hostKeyList) fields.hostKeyList = hostKeyList.split(',').map((s) => s.trim()).filter(Boolean);

    // "Work/Prod" -> folder "Work", name "Prod".
    const segments = section.name.split('/').filter(Boolean);
    const name = segments.pop() || section.name;
    return importedSite(fields, { source, name, folder: segments.join('/') });
  }).filter((entry) => !!entry.site.hostName);
}

/* ================================================================== */
/* known_hosts                                                         */
/* ================================================================== */

/**
 * parseKnownHosts(text) -> imported[]
 *
 * A known_hosts file names hosts and pins their keys but carries no user name
 * and no protocol, so each entry becomes an SFTP site with its fingerprint
 * pre-trusted. Hashed (`|1|…`) entries are deliberately skipped: the host name
 * is not recoverable from a hash, and inventing one would be a lie.
 */
export function parseKnownHosts(text, { source = 'knownhosts' } = {}) {
  const lines = guard(text).split(/\r?\n/);
  const seen = new Map();
  let hashed = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    let hostField = parts[0];
    if (hostField === '@cert-authority' || hostField === '@revoked') { hostField = parts[1]; parts.shift(); }
    if (!hostField) continue;
    if (hostField.startsWith('|')) { hashed += 1; continue; }
    const keyType = parts[1] || '';
    const keyBlob = parts[2] || '';

    for (const entry of hostField.split(',')) {
      if (seen.size >= MAX_SITES) break;
      let host = entry;
      let port = 22;
      const bracketed = /^\[(.+)\]:(\d+)$/.exec(entry);
      if (bracketed) { host = bracketed[1]; port = Number.parseInt(bracketed[2], 10) || 22; }
      if (!host || host.includes('*') || host.includes('?')) continue;
      const key = `${host}:${port}`;
      if (seen.has(key)) continue;
      seen.set(key, importedSite({
        protocol: 'sftp', hostName: host, portNumber: port,
        hostKey: keyType && keyBlob ? `${keyType} ${keyBlob}` : '',
        __warnings: ['known_hosts records no user name; add one before connecting.'],
      }, { source, name: host }));
    }
  }

  const out = Array.from(seen.values());
  if (hashed && out.length) {
    out[0].warnings = [...out[0].warnings,
      `${hashed} hashed entr${hashed === 1 ? 'y was' : 'ies were'} skipped: a hashed known_hosts line does not contain a recoverable host name.`];
  }
  return out;
}

/* ================================================================== */
/* the source registry                                                 */
/* ================================================================== */

export const IMPORT_SOURCES = Object.freeze([
  {
    id: 'putty', label: 'PuTTY', icon: 'terminal',
    accept: '.reg,text/plain',
    hint: 'A registry export of HKCU\\Software\\SimonTatham\\PuTTY\\Sessions. Produce one with: regedit /e putty.reg "HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY"',
    parse: (text) => parsePuttyRegistry(text, { source: 'putty' }),
  },
  {
    id: 'kitty', label: 'KiTTY', icon: 'terminal',
    accept: '.reg,text/plain',
    hint: 'KiTTY stores sessions in the same shape as PuTTY, under 9bis.com\\KiTTY. Export it the same way.',
    parse: (text) => parsePuttyRegistry(text, { source: 'kitty' }),
  },
  {
    id: 'filezilla', label: 'FileZilla', icon: 'description',
    accept: '.xml,text/xml',
    hint: 'FileZilla’s sitemanager.xml, usually under %APPDATA%\\FileZilla.',
    parse: (text) => parseFileZillaXml(text),
  },
  {
    id: 'openssh', label: 'OpenSSH', icon: 'key',
    accept: '.config,.txt,text/plain',
    hint: 'An OpenSSH client config, usually ~/.ssh/config. Every literal Host alias becomes a site; wildcard patterns configure the others.',
    parse: (text) => parseOpenSshConfig(text),
  },
  {
    id: 'ini', label: 'INI file', icon: 'settings',
    accept: '.ini,text/plain',
    hint: 'A WinSCP.ini written by WinSCP itself. Section names carry the folder structure.',
    parse: (text) => parseWinScpIni(text),
  },
  {
    id: 'knownhosts', label: 'known_hosts', icon: 'shield_lock',
    accept: '.txt,text/plain',
    hint: 'An OpenSSH known_hosts file. Each host becomes a site with its key already trusted.',
    parse: (text) => parseKnownHosts(text),
  },
]);

/** importSitesFrom('putty', text) -> imported[] — throws with a real reason. */
export function importSitesFrom(sourceId, text) {
  const source = IMPORT_SOURCES.find((s) => s.id === sourceId);
  if (!source) throw new Error(`"${sourceId}" is not an import source this application knows.`);
  return source.parse(text);
}

/* ================================================================== */
/* the dialog                                                          */
/* ================================================================== */

export function createImportPanel(opts = {}) {
  installSessionDialogStyles();

  const state = {
    sourceId: opts.sourceId || 'putty',
    entries: [],
    checked: new Set(),
    error: '',
    fileName: '',
  };

  const sourceId = uid('im-source');
  const sourceSelect = h('select', {
    class: 'sd-input', id: sourceId,
    onchange: () => { state.sourceId = sourceSelect.value; state.entries = []; state.error = ''; paint(); },
  }, ...IMPORT_SOURCES.map((s) => h('option', { value: s.id }, s.label)));
  sourceSelect.value = state.sourceId;

  const hintEl = h('p', { class: 'sd-hint prose' });
  const errorEl = h('div', { class: 'sd-note is-warn', hidden: true });
  const listEl = h('div', { class: 'im-list', role: 'group', 'aria-label': t('importFound') });
  const summaryEl = h('div', { class: 'sd-hint' });
  appearanceTarget(listEl, 'import-sites-list', 'Imported site list');

  const search = createSearchBar({
    id: 'import-sites',
    persist: false,
    labelKey: 'searchSites',
    placeholder: 'Search the sites found',
    sampleProvider: () => state.entries.map((e) => `${e.site.name}\t${e.site.hostName}\t${e.site.userName}`).join('\n'),
    onChange: renderList,
  });

  const browseBtn = h('button', { type: 'button', class: 'btn-tonal', onclick: browse },
    icon('folder_open', 16), h('span', {}, t('browse')));
  const pasteBtn = h('button', { type: 'button', class: 'btn-tonal', onclick: paste },
    icon('content_copy', 16), h('span', {}, s('paste')));
  const checkAllBtn = h('button', { type: 'button', class: 'btn-text', onclick: toggleAll },
    icon('done_all', 16), h('span', {}, s('checkAll')));

  const element = h('div', { class: 'stack sd-wide sd-wide-sm' },
    h('div', { class: 'sd-grid' },
      h('label', { class: 'sd-label', for: sourceId }, t('importFrom')),
      sourceSelect),
    hintEl,
    h('div', { class: 'sd-btnrow' }, browseBtn, pasteBtn, h('span', { class: 'spacer' }), checkAllBtn),
    errorEl,
    search.element,
    listEl,
    summaryEl);

  function paint() {
    const source = IMPORT_SOURCES.find((s) => s.id === state.sourceId);
    hintEl.textContent = source ? source.hint : '';
    errorEl.hidden = !state.error;
    if (state.error) {
      clear(errorEl);
      errorEl.append(icon('warning', 15), h('span', {}, state.error));
    }
    renderList();
  }

  function visibleEntries() {
    if (!search.isActive) return state.entries;
    return filterBy(state.entries, search.predicate,
      (e) => [e.site.name, e.site.hostName, e.site.userName, e.site.folder]);
  }

  function renderList() {
    clear(listEl);
    const entries = visibleEntries();
    if (!state.entries.length) {
      listEl.appendChild(h('p', { class: 'st-empty prose' },
        state.fileName
          ? t('importNone')
          : 'Choose a source above, then Browse to a file or Paste its text.'));
    } else if (!entries.length) {
      listEl.appendChild(h('p', { class: 'st-empty prose' }, noMatchMessage(search.predicate, 'the sites found')));
    } else {
      for (const entry of entries) listEl.appendChild(buildEntryRow(entry));
    }
    const total = state.entries.length;
    const chosen = state.checked.size;
    summaryEl.textContent = total
      ? `${chosen} of ${total} selected${state.fileName ? ` from ${state.fileName}` : ''}.`
      : '';
  }

  function buildEntryRow(entry) {
    const id = uid('im-item');
    const box = h('input', {
      type: 'checkbox', id,
      onchange: () => {
        if (box.checked) state.checked.add(entry); else state.checked.delete(entry);
        renderList();
      },
    });
    box.checked = state.checked.has(entry);
    const bits = [entry.site.hostName];
    if (entry.site.userName) bits.push(entry.site.userName);
    if (entry.site.folder) bits.push(`in ${entry.site.folder}`);
    if (entry.hasPassword) bits.push('password included');
    const sub = bits.join(' · ');

    const row = h('label', { class: 'im-item', for: id }, box,
      h('span', { class: 'st-icon' }, icon(protocolIconFor(entry.site.protocol), 16)),
      h('span', { class: 'im-item-main' },
        h('span', { class: 'im-item-name', title: entry.site.name }, entry.site.name),
        h('span', { class: 'im-item-sub', title: sub }, sub)));

    if (entry.warnings.length) {
      row.appendChild(h('span', {
        class: 'st-icon', title: entry.warnings.join('\n'),
        role: 'img', 'aria-label': `Warning: ${entry.warnings.join(' ')}`,
      }, icon('warning', 16)));
    }
    return row;
  }

  function protocolIconFor(protocol) {
    return { sftp: 'shield_lock', scp: 'terminal', ftp: 'lan', webdav: 'cloud', s3: 'database' }[protocol] || 'dns';
  }

  function toggleAll() {
    const entries = visibleEntries();
    const allOn = entries.length > 0 && entries.every((e) => state.checked.has(e));
    for (const entry of entries) { if (allOn) state.checked.delete(entry); else state.checked.add(entry); }
    renderList();
    announce(allOn ? 'All cleared.' : `${state.checked.size} selected.`);
  }

  function ingest(text, fileName) {
    state.fileName = fileName || '';
    try {
      state.entries = importSitesFrom(state.sourceId, text);
      state.checked = new Set(state.entries);
      state.error = state.entries.length ? '' : 'No sites were found in that file. Check that the source above matches the file you chose.';
    } catch (err) {
      state.entries = [];
      state.checked = new Set();
      state.error = err.message || String(err);
    }
    paint();
    if (state.entries.length) {
      notify.success(t('importTitle'), t('importFound', String(state.entries.length)));
    }
  }

  /**
   * The browser's own file input, deliberately. main's app:pickPath returns a
   * path but the bridge exposes no "read a local text file" call, so a path
   * alone would leave nothing to parse; the DOM picker hands back the text and
   * works identically inside the app and in a plain browser.
   */
  async function browse() {
    const source = IMPORT_SOURCES.find((s) => s.id === state.sourceId);
    const picked = await pickTextFile(source?.accept || '.txt,text/plain');
    if (!picked) return;
    ingest(picked.text, picked.name);
  }

  async function paste() {
    let text = '';
    try {
      const res = await api.raw?.app?.clipboardRead?.();
      text = res?.ok ? String(res.value || '') : '';
    } catch { /* fall through to the browser clipboard */ }
    if (!text) {
      try { text = await navigator.clipboard.readText(); } catch { text = ''; }
    }
    if (!text) {
      notify.warning(t('importFrom'), 'The clipboard is empty, or this window was refused access to it. Use Browse instead.');
      return;
    }
    ingest(text, 'the clipboard');
  }

  async function apply() {
    const chosen = Array.from(state.checked);
    if (!chosen.length) {
      notify.warning(t('importTitle'), 'Nothing is selected, so nothing was imported.');
      return false;
    }
    let added = 0;
    const failures = [];
    for (const entry of chosen) {
      try {
        const folder = entry.site.folder;
        if (folder) await siteStore.addFolder(folder).catch(() => {});
        // eslint-disable-next-line no-unused-vars
        const { __warnings, ...clean } = entry.site;
        await siteStore.addSite(clean);
        added += 1;
      } catch (err) {
        failures.push(`${entry.site.name}: ${err.message || err}`);
      }
    }
    notifySitesChanged();
    await api.historyRecord(`Imported ${added} site${added === 1 ? '' : 's'} from ${state.sourceId}`);
    if (failures.length) {
      notify.error(t('importTitle'), `${added} imported, ${failures.length} failed:\n${failures.slice(0, 5).join('\n')}`);
    } else {
      notify.success(t('importDone'), t('importFound', String(added)));
    }
    opts.onImported?.(added);
    return true;
  }

  paint();

  return {
    element,
    apply,
    ingest,
    get entries() { return state.entries.slice(); },
    get selectedCount() { return state.checked.size; },
    destroy() { search.destroy(); element.remove(); },
  };
}

let installed = false;

/** Deferred for the same import-cycle reason as every other dialog here. */
export function registerImportSessionsDialog() {
  if (installed) return;
  installed = true;
  registerDialog('importSessions', ({ props }) => {
    const panel = createImportPanel(props);
    return {
      title: t('importTitle'),
      width: 640,
      content: panel.element,
      onClose: () => panel.destroy(),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('ok'), kind: 'filled', autofocus: true,
          onSelect: (close) => {
            // apply() is asynchronous, so the dialog stays open until it has
            // actually written the sites rather than closing on a promise.
            panel.apply().then((ok) => { if (ok) close('imported'); });
            return true;
          },
        },
      ],
    };
  });
}

export function openImportSessions(props = {}) {
  registerImportSessionsDialog();
  return openDialog('importSessions', props);
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { registerImportSessionsDialog(); } catch (err) { console.error('[importSessions] registration failed', err); }
  });
}
