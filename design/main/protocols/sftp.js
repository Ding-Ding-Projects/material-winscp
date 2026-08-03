// sftp.js — SFTP over SSH, plus `SshTransport`, the shared SSH connection that
// scp.js reuses. Everything about *getting* an SSH connection (proxy, tunnel,
// host-key verification, authentication, keepalives, rekeying) lives in the
// transport; everything about *speaking SFTP* lives in the adapter.
//
// Two rules shape this file:
//   - A host key is never accepted without the injected verifier saying so.
//     No verifier means no connection, because "trust on first use, silently"
//     is exactly the hole SSH exists to close.
//   - Nothing secret is ever written to the session log. Commands and replies
//     are logged at debug level; passwords, passphrases and key bytes are not.
'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Duplex, Readable, Writable } = require('stream');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const { Client } = require('ssh2');
const { Adapter, entry } = require('./base');
const ext = require('./sftp-extensions');

// ssh2 validates every algorithm name against its own supported list and throws
// on anything it does not know, so WinSCP's families are filtered against it.
// Reaching into the module is deliberate and guarded: if the internal path ever
// moves, the algorithm preferences are simply left at ssh2's defaults.
let SUPPORTED = null;
try {
  const c = require('ssh2/lib/protocol/constants.js');
  SUPPORTED = {
    cipher: c.SUPPORTED_CIPHER,
    kex: c.SUPPORTED_KEX,
    serverHostKey: c.SUPPORTED_SERVER_HOST_KEY,
    compress: c.SUPPORTED_COMPRESSION,
  };
} catch { SUPPORTED = null; }

// WinSCP's algorithm families to the concrete names ssh2 negotiates.
const CIPHERS = {
  aes: ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-ctr', 'aes192-ctr',
    'aes128-ctr', 'aes256-cbc', 'aes192-cbc', 'aes128-cbc'],
  chacha20: ['chacha20-poly1305@openssh.com'],
  '3des': ['3des-cbc'],
  des: [], blowfish: [], arcfour: [],
};
const KEXES = {
  ecdh: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'],
  'dh-gex-sha1': ['diffie-hellman-group-exchange-sha256', 'diffie-hellman-group-exchange-sha1'],
  'dh-group18-sha512': ['diffie-hellman-group18-sha512'],
  'dh-group17-sha512': ['diffie-hellman-group17-sha512'],
  'dh-group16-sha512': ['diffie-hellman-group16-sha512'],
  'dh-group15-sha512': ['diffie-hellman-group15-sha512'],
  'dh-group14-sha1': ['diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1'],
  rsa: [],
  'dh-group1-sha1': ['diffie-hellman-group1-sha1'],
};
const HOSTKEYS = {
  ed448: [], // ssh2 has no ssh-ed448
  ed25519: ['ssh-ed25519'],
  ecdsa: ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
  rsa: ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
  dsa: ['ssh-dss'],
};

/** Apply SiteAdvanced's send buffer without allowing malformed imports to
 * poison the ssh2 connection options. */
function applySshSendBuffer(cfg, value) {
  const sendBuf = Number(value);
  if (Number.isFinite(sendBuf) && sendBuf > 0) cfg.highWaterMark = sendBuf;
  return cfg;
}

/**
 * Expand a WinSCP preference list into ssh2 names. Entries after the 'WARN'
 * marker are the ones WinSCP would stop and warn about; with no channel to ask
 * the user on, they are dropped rather than silently negotiated.
 */
function algorithmList(prefs, table, supported) {
  if (!Array.isArray(prefs) || !supported) return null;
  const out = [];
  const dropped = [];
  let warned = false;
  for (const name of prefs) {
    if (name === 'WARN') { warned = true; continue; }
    const mapped = table[name];
    if (!mapped || !mapped.length) { dropped.push(name); continue; }
    for (const a of mapped) {
      if (!supported.includes(a)) continue;
      if (warned) { if (!dropped.includes(name)) dropped.push(name); continue; }
      if (!out.includes(a)) out.push(a);
    }
  }
  return { list: out, dropped };
}

/**
 * An explicit SSH policy is a security boundary, not a hint. If every name a
 * site selected is unavailable in this build (or was placed below WARN),
 * leaving the field out would make ssh2 negotiate its own defaults instead.
 * Refuse before the client sends an SSH identification string.
 */
function requireAlgorithmPolicy(label, prefs, resolved, sock) {
  if (!Array.isArray(prefs) || prefs.length === 0 || !resolved || resolved.list.length) return;
  const requested = prefs.filter((name) => name !== 'WARN').join(', ') || '(none)';
  try { sock.destroy(); } catch { /* the caller is already failing closed */ }
  const error = new Error(`SSH ${label} policy has no algorithms supported by this build: ${requested}`);
  error.code = 'ERR_SSH_ALGORITHM_POLICY';
  throw error;
}

// ------------------------------------------------------------- fingerprints

/** Read one SSH wire string (uint32 length + bytes) at `off`. */
function wireString(buf, off) {
  if (buf.length < off + 4) return null;
  const len = buf.readUInt32BE(off);
  if (buf.length < off + 4 + len) return null;
  return buf.subarray(off + 4, off + 4 + len);
}

/** OpenSSH-style fingerprints for a host key in wire format. */
function fingerprints(key) {
  const algo = wireString(key, 0);
  const md5 = crypto.createHash('md5').update(key).digest('hex').match(/../g).join(':');
  const sha256 = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return {
    algorithm: algo ? algo.toString('utf8') : 'unknown',
    sha256: 'SHA256:' + sha256,
    md5: 'MD5:' + md5,
    size: key.length,
  };
}

// ------------------------------------------------------------------- proxies

/** A tiny sequential reader over a socket, for the proxy handshakes. */
function reader(sock) {
  let buf = Buffer.alloc(0);
  let pending = null;
  const settle = () => {
    if (!pending) return;
    const take = pending.need(buf);
    if (take == null) return;
    const p = pending; pending = null;
    const out = buf.subarray(0, take);
    buf = buf.subarray(take);
    p.resolve(out);
  };
  const fail = (e) => { if (pending) { const p = pending; pending = null; p.reject(e); } };
  const onData = (d) => { buf = Buffer.concat([buf, d]); settle(); };
  const onError = (e) => fail(e);
  const onClose = () => fail(new Error('The proxy closed the connection during the handshake'));
  sock.on('data', onData);
  sock.on('error', onError);
  sock.on('close', onClose);
  const api = {
    want(need) { return new Promise((resolve, reject) => { pending = { need, resolve, reject }; settle(); }); },
    bytes(n) { return api.want((b) => (b.length >= n ? n : null)); },
    until(delim) { return api.want((b) => { const i = b.indexOf(delim); return i < 0 ? null : i + delim.length; }); },
    /** Hand the socket back with anything already buffered pushed in front. */
    release() {
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      sock.removeListener('close', onClose);
      if (buf.length) sock.unshift(buf);
      buf = Buffer.alloc(0);
    },
  };
  return api;
}

function rawSocket(session, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const opts = { host, port };
    if (session.addressFamily === 'ipv4') opts.family = 4;
    else if (session.addressFamily === 'ipv6') opts.family = 6;
    if (session.sourceAddress) opts.localAddress = session.sourceAddress;
    const sock = net.connect(opts);
    const onError = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(timeoutMs, () => onError(new Error(`Timed out connecting to ${host}:${port}`)));
    sock.once('error', onError);
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.removeListener('error', onError);
      sock.setNoDelay(true);
      resolve(sock);
    });
  });
}

async function httpProxy(session, sock, host, port, log) {
  const r = reader(sock);
  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
  if (session.proxyUsername) {
    const token = Buffer.from(`${session.proxyUsername}:${session.proxyPassword || ''}`).toString('base64');
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  lines.push('Proxy-Connection: keep-alive', '', '');
  log('debug', `HTTP proxy: CONNECT ${host}:${port}`);
  sock.write(lines.join('\r\n'));
  const head = (await r.until(Buffer.from('\r\n\r\n'))).toString('latin1');
  const status = /^HTTP\/1\.[01] (\d{3})(.*)$/m.exec(head);
  if (!status || status[1] !== '200') {
    r.release(); sock.destroy();
    throw new Error(`The HTTP proxy refused the connection: ${status ? status[1] + status[2] : head.split('\r\n')[0]}`);
  }
  log('debug', 'HTTP proxy: tunnel established');
  r.release();
  return sock;
}

async function socks4Proxy(session, sock, host, port, log) {
  const r = reader(sock);
  const isIPv4 = net.isIPv4(host);
  const user = Buffer.from(session.proxyUsername || '', 'utf8');
  const head = Buffer.alloc(8);
  head[0] = 4; head[1] = 1;
  head.writeUInt16BE(port, 2);
  if (isIPv4) {
    host.split('.').forEach((o, i) => { head[4 + i] = Number(o); });
  } else {
    // SOCKS4a: 0.0.0.x means "resolve this name at the proxy".
    head[4] = 0; head[5] = 0; head[6] = 0; head[7] = 1;
  }
  const parts = [head, user, Buffer.from([0])];
  if (!isIPv4) parts.push(Buffer.from(host, 'utf8'), Buffer.from([0]));
  log('debug', `SOCKS4${isIPv4 ? '' : 'a'} proxy: connect ${host}:${port}`);
  sock.write(Buffer.concat(parts));
  const reply = await r.bytes(8);
  if (reply[1] !== 0x5a) {
    r.release(); sock.destroy();
    throw new Error(`The SOCKS4 proxy refused the connection (code 0x${reply[1].toString(16)})`);
  }
  log('debug', 'SOCKS4 proxy: tunnel established');
  r.release();
  return sock;
}

async function socks5Proxy(session, sock, host, port, log) {
  const r = reader(sock);
  const wantAuth = !!session.proxyUsername;
  sock.write(wantAuth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
  const greeting = await r.bytes(2);
  if (greeting[0] !== 5) { r.release(); sock.destroy(); throw new Error('The SOCKS5 proxy sent an unexpected greeting'); }
  if (greeting[1] === 0xff) { r.release(); sock.destroy(); throw new Error('The SOCKS5 proxy accepted none of the offered authentication methods'); }
  if (greeting[1] === 2) {
    const u = Buffer.from(session.proxyUsername || '', 'utf8');
    const p = Buffer.from(session.proxyPassword || '', 'utf8');
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const res = await r.bytes(2);
    if (res[1] !== 0) { r.release(); sock.destroy(); throw new Error('The SOCKS5 proxy rejected the username and password'); }
  } else if (greeting[1] !== 0) {
    r.release(); sock.destroy();
    throw new Error(`The SOCKS5 proxy asked for authentication method 0x${greeting[1].toString(16)}, which is not supported`);
  }

  let request;
  const remoteDns = session.proxyDNS !== 'off';
  if (net.isIPv4(host)) {
    request = Buffer.concat([Buffer.from([5, 1, 0, 1]), Buffer.from(host.split('.').map(Number)), portBuf(port)]);
  } else if (net.isIPv6(host)) {
    request = Buffer.concat([Buffer.from([5, 1, 0, 4]), ipv6Bytes(host), portBuf(port)]);
  } else if (remoteDns) {
    const name = Buffer.from(host, 'utf8');
    request = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBuf(port)]);
  } else {
    const { address } = await require('dns').promises.lookup(host);
    request = Buffer.concat([Buffer.from([5, 1, 0, 1]), Buffer.from(address.split('.').map(Number)), portBuf(port)]);
  }
  log('debug', `SOCKS5 proxy: connect ${host}:${port}`);
  sock.write(request);

  const head = await r.bytes(4);
  if (head[1] !== 0) {
    r.release(); sock.destroy();
    throw new Error(`The SOCKS5 proxy refused the connection (code 0x${head[1].toString(16)})`);
  }
  if (head[3] === 1) await r.bytes(4 + 2);
  else if (head[3] === 4) await r.bytes(16 + 2);
  else if (head[3] === 3) { const len = await r.bytes(1); await r.bytes(len[0] + 2); }
  log('debug', 'SOCKS5 proxy: tunnel established');
  r.release();
  return sock;
}

function portBuf(port) { const b = Buffer.alloc(2); b.writeUInt16BE(port, 0); return b; }

function ipv6Bytes(addr) {
  const out = Buffer.alloc(16);
  const halves = addr.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  head.forEach((h, i) => out.writeUInt16BE(parseInt(h, 16) || 0, i * 2));
  tail.forEach((h, i) => out.writeUInt16BE(parseInt(h, 16) || 0, 16 - (tail.length - i) * 2));
  return out;
}

async function telnetProxy(session, sock, host, port, log) {
  const command = String(session.proxyTelnetCommand || 'connect %host %port\\n')
    .replace(/%host/g, host)
    .replace(/%port/g, String(port))
    .replace(/%user/g, session.proxyUsername || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
  log('debug', `Telnet proxy: sending the configured connect command for ${host}:${port}`);
  sock.write(command);
  return sock;
}

/** A local proxy command's stdio, presented to ssh2 as a socket. */
class CommandSocket extends Duplex {
  constructor(command) {
    super();
    this.child = spawn(command, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.remoteAddress = 'local-command';
    this.remotePort = 0;
    this.child.stdout.on('data', (d) => { if (!this.push(d)) this.child.stdout.pause(); });
    this.child.stdout.on('end', () => this.push(null));
    this.child.on('error', (e) => this.destroy(e));
    this.child.on('exit', (code) => {
      if (code) this.destroy(new Error(`The local proxy command exited with code ${code}`));
      else this.push(null);
    });
    this._stderr = '';
    this.child.stderr.on('data', (d) => { this._stderr = (this._stderr + d.toString()).slice(-4096); });
  }
  _read() { this.child.stdout.resume(); }
  _write(chunk, enc, cb) { this.child.stdin.write(chunk, cb); }
  _final(cb) { this.child.stdin.end(); cb(); }
  _destroy(err, cb) { try { this.child.kill(); } catch { /* already gone */ } cb(err); }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout() { return this; }
}

/** Build the socket the SSH session will run over, honouring session.proxy*. */
/**
 * `TSecureShell::TryFtp`'s knock: connect to port 21 and wait 2000 ms.
 *
 * The timeout is the original's, and it is short on purpose — this runs after a
 * connection has ALREADY failed, so a user waiting on an error must not then
 * wait on a probe. Nothing is sent and nothing is read: the question is only
 * whether a TCP connection is accepted at all.
 */
const FTP_PORT_NUMBER = 21;
const FTP_KNOCK_TIMEOUT_MS = 2000;

function knockFtpPort(host, timeoutMs) {
  return new Promise((resolve) => {
    if (!host) { resolve(false); return; }
    let settled = false;
    const done = (answer) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(answer);
    };
    const socket = net.connect({ host, port: FTP_PORT_NUMBER });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function openSocket(session, host, port, timeoutMs, log) {
  const method = session.proxyMethod || 'none';
  if (method === 'none') return rawSocket(session, host, port, timeoutMs);
  if (method === 'cmd') {
    const command = String(session.proxyLocalCommand || '')
      .replace(/%host/g, host).replace(/%port/g, String(port))
      .replace(/%user/g, session.proxyUsername || '');
    if (!command) throw new Error('The local proxy command is empty');
    log('debug', 'Local command proxy: starting the configured command');
    return new CommandSocket(command);
  }
  if (method === 'system') {
    throw new Error('The "system proxy settings" method is not supported; choose HTTP, SOCKS4, SOCKS5, Telnet or a local command.');
  }
  if (!session.proxyHost) throw new Error(`The ${method} proxy has no host name configured`);
  const proxyPort = Number(session.proxyPort) || (method === 'http' ? 3128 : 1080);
  const sock = await rawSocket({ addressFamily: session.addressFamily, sourceAddress: session.sourceAddress },
    session.proxyHost, proxyPort, timeoutMs);
  if (method === 'http') return httpProxy(session, sock, host, port, log);
  if (method === 'socks4') return socks4Proxy(session, sock, host, port, log);
  if (method === 'socks5') return socks5Proxy(session, sock, host, port, log);
  if (method === 'telnet') return telnetProxy(session, sock, host, port, log);
  sock.destroy();
  throw new Error(`Unknown proxy method "${method}"`);
}

// ---------------------------------------------------------------- transport

/** Where the SSH agent lives on this host. */
function pageantRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const probe = spawnSync('tasklist.exe', [
      '/FI', 'IMAGENAME eq pageant.exe', '/NH', '/FO', 'CSV',
    ], {
      encoding: 'utf8', windowsHide: true, timeout: 1500,
    });
    return probe.status === 0 && /"pageant\.exe"/i.test(probe.stdout || '');
  } catch {
    return false;
  }
}

function agentPath() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform !== 'win32') return null;
  // Windows OpenSSH publishes a named pipe; Pageant uses a window message and
  // is what WinSCP itself talks to. ssh2 treats an absent Pageant as a fatal
  // agent error, so offer it only while its process is actually present; a
  // missing optional agent must never prevent password authentication.
  try { if (fs.existsSync('\\\\.\\pipe\\openssh-ssh-agent')) return '\\\\.\\pipe\\openssh-ssh-agent'; } catch { /* not present */ }
  return pageantRunning() ? 'pageant' : null;
}

/**
 * One authenticated SSH connection. Owns the socket, so proxying, address
 * family, source address, rekeying by time/volume and byte accounting are all
 * possible; ssh2 is handed a ready-made socket in every case.
 */
class SshTransport extends EventEmitter {
  /**
   * @param session   resolved session data (defaults.js shape, secrets in clear)
   * @param options   { hostKeyVerifier, keyboardInteractive, label }
   */
  constructor(session, options = {}) {
    super();
    this.session = session || {};
    this.options = options;
    this.client = null;
    this.socket = null;
    this.tunnelClient = null;
    this.tunnelServer = null;
    this.serverInfo = {};
    this.connected = false;
    this._rekeyTimer = null;
    this._rekeyBytes = 0;
    this._closing = false;
    this._storedCredentialsTried = false;
    this._authenticating = false;
    this._authenticationCancelled = false;
    this._authenticationLog = [];
    this.banners = [];
    this.hostKeyAlgorithm = null;
    this.lastError = null;
  }

  log(level, message) { this.emit('log', { level, message }); }

  /**
   * The server's identification, minus the `SSH-2.0-` prefix — the same string
   * WinSCP calls `SshImplementation` and keys every workaround on.
   */
  get sshImplementation() {
    const proto = this.client && this.client._protocol;
    const raw = proto && proto._remoteIdentRaw;
    if (!raw) return '';
    const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
    return text.replace(/^SSH-\d+\.\d+-/, '');
  }

  /** Which known-broken server this is, for the workaround matrix. */
  get implementation() { return ext.detectSshImplementation(this.sshImplementation); }

  /**
   * Classify a failure the way `TSecureShell` does, and remember it. Callers
   * decide whether to reconnect from `retriable` and whether to stop asking for
   * credentials from `authenticationHopeless` — a distinction that matters,
   * because a server counting failed attempts will lock the account out if we
   * treat "wrong password" as "try again".
   */
  classify(error) {
    const info = ext.classifySshError(error, {
      hostName: this.session.hostName,
      storedCredentialsTried: this._storedCredentialsTried,
      cancelled: this._authenticationCancelled,
      closing: this._closing,
    });
    if (this._authenticating && info.kind === 'unknown' && this._authenticationLog.length) {
      // WinSCP's Init(): an unexplained failure during authentication is
      // reported with the authentication log attached, because the log is the
      // only thing that says which method the server actually refused.
      info.kind = 'authentication';
      info.message = `Authentication log (see session log for details):\n${this._authenticationLog.join('\n')}\n`;
      info.authenticationHopeless = false;
    }
    this.lastError = info;
    return info;
  }

  /**
   * `TSecureShell::TryFtp`, in full.
   *
   * The refusals (wrong protocol, non-standard port, a tunnel, a proxy, the
   * preference turned off) are `shouldSuggestFtp`'s. What it cannot do is the
   * second half: the original OPENS A SOCKET to port 21 and waits 2000 ms, and
   * only suggests FTP once that connect succeeds. Skipping the knock leaves the
   * message asserting "but it listens for FTP connections" about a server
   * nothing has spoken to — a sentence that sends a user to change their
   * protocol on the strength of a guess.
   */
  async ftpSuggestion(classification) {
    const verdict = ext.shouldSuggestFtp(this.session, classification || this.lastError || {}, this.options);
    if (!verdict.suggest) return verdict;
    const reachable = await knockFtpPort(this.session.hostName, FTP_KNOCK_TIMEOUT_MS);
    if (!reachable) {
      return { suggest: false, reason: 'nothing answered on the FTP port either' };
    }
    return verdict;
  }

  get timeoutMs() { return Math.max(1, Number(this.session.timeout) || 15) * 1000; }

  async connect() {
    const s = this.session;
    const host = s.hostName;
    const port = Number(s.portNumber) || 22;
    if (!host) throw new Error('The session has no host name');

    // Everything from opening the socket to being authenticated is classified,
    // because the two failures a user hits most — "nothing is listening" and
    // "your password is wrong" — arrive from opposite ends of that range and
    // need opposite answers from the reconnect logic.
    try {
      let sock;
      if (s.tunnel) {
        sock = await this._openTunnel(host, port);
      } else {
        sock = await openSocket(s, host, port, this.timeoutMs, (l, m) => this.log(l, m));
      }
      this.socket = sock;

      this.client = await this._authenticate({
        label: 'session',
        host,
        port,
        username: s.userName,
        password: s.password,
        publicKeyFile: s.publicKeyFile,
        passphrase: s.passphrase,
        knownHostKey: s.hostKey,
      }, sock);
    } catch (e) {
      // A failed handshake/authentication must not leave a live socket or
      // tunnel channel behind.  Apart from leaking resources, ssh2 may emit
      // a later channel error into a session that is already retrying.  Keep
      // `_closing` false here so a caller may safely retry this transport.
      this._abortConnection();
      // `error.ssh` is what the session layer reads to decide whether
      // reconnecting could help and whether asking for the password again is
      // worth anything at all.
      const info = this.classify(e);
      e.ssh = info;
      e.ftpSuggestion = await this.ftpSuggestion(info);
      if (info.message && info.message !== e.message) {
        this.log('error', info.message);
      }
      throw e;
    }

    this.connected = true;
    this._authenticating = false;
    this._startRekeyPolicy();
    return this;
  }

  /** Tear down a partially opened connection without making retry look cancelled. */
  _abortConnection() {
    try { if (this.client) this.client.end(); } catch { /* already down */ }
    try { if (this.tunnelClient) this.tunnelClient.end(); } catch { /* already down */ }
    try { if (this.tunnelServer) this.tunnelServer.close(); } catch { /* already down */ }
    try { if (this.socket) this.socket.destroy(); } catch { /* already down */ }
    this.connected = false;
    this.client = null;
    this.tunnelClient = null;
    this.tunnelServer = null;
    this.socket = null;
  }

  /**
   * The tunnel session is a complete SSH connection of its own; the real
   * session then runs inside a direct-tcpip channel opened on it. When a
   * local port is configured the channel is fronted by a real listener, so
   * other tools can use the same forward.
   */
  async _openTunnel(host, port) {
    const s = this.session;
    const tHost = s.tunnelHostName;
    const tPort = Number(s.tunnelPortNumber) || 22;
    if (!tHost) throw new Error('The tunnel is enabled but has no host name');
    this.log('info', `Opening the tunnel to ${tHost}:${tPort}`);

    const tunnelSock = await openSocket(s, tHost, tPort, this.timeoutMs, (l, m) => this.log(l, m));
    this.tunnelClient = await this._authenticate({
      label: 'tunnel',
      host: tHost,
      port: tPort,
      username: s.tunnelUserName,
      password: s.tunnelPassword,
      publicKeyFile: s.tunnelPublicKeyFile,
      passphrase: s.tunnelPassphrase,
      knownHostKey: s.tunnelHostKey,
    }, tunnelSock);

    const forward = () => new Promise((resolve, reject) => {
      this.tunnelClient.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
        if (err) reject(err); else resolve(stream);
      });
    });

    const localPort = Number(s.tunnelLocalPortNumber) || 0;
    if (!localPort) {
      this.log('info', `Tunnel open; forwarding to ${host}:${port}`);
      return forward();
    }

    await new Promise((resolve, reject) => {
      this.tunnelServer = net.createServer((client) => {
        this.tunnelClient.forwardOut('127.0.0.1', localPort, host, port, (err, stream) => {
          if (err) { this.log('error', `Tunnel forward failed: ${err.message}`); client.destroy(); return; }
          client.pipe(stream).pipe(client);
        });
      });
      this.tunnelServer.once('error', reject);
      this.tunnelServer.listen(localPort, '127.0.0.1', resolve);
    });
    this.log('info', `Tunnel listening on 127.0.0.1:${localPort}, forwarding to ${host}:${port}`);
    return rawSocket({}, '127.0.0.1', localPort, this.timeoutMs);
  }

  /** Connect and authenticate one leg of the session over an existing socket. */
  _authenticate(profile, sock) {
    const s = this.session;
    const client = new Client();
    const hostPort = `${profile.host}:${profile.port}`;

    const cfg = {
      sock,
      host: profile.host,
      port: profile.port,
      username: profile.username || os.userInfo().username,
      readyTimeout: this.timeoutMs,
      tryKeyboard: !!s.authKI,
      agentForward: !!s.agentFwd,
      hostVerifier: (key, verify) => {
        const fp = fingerprints(key);
        this.log('debug', `${profile.label} host key ${fp.algorithm} ${fp.sha256}`);
        const verifier = this.options.hostKeyVerifier;
        if (typeof verifier !== 'function') {
          this.log('error', 'No host-key verifier was supplied; refusing to trust the server');
          verify(false);
          return;
        }
        Promise.resolve(verifier(hostPort, fp.sha256, fp.algorithm, {
          md5: fp.md5, key, expected: profile.knownHostKey || '', leg: profile.label,
        })).then((ok) => {
          if (ok !== true) this.log('error', `The host key for ${hostPort} was rejected`);
          verify(ok === true);
        }).catch((e) => {
          this.log('error', `Host-key verification failed: ${e.message}`);
          verify(false);
        });
      },
    };

    // SiteAdvanced's SSH buffer setting maps to ssh2's parser stream buffer.
    // Keep the default when an imported/raw value is invalid; the connection
    // must never fail just because an old profile contains a bad number.
    applySshSendBuffer(cfg, s.sendBuf);

    if (s.agentFwd && !s.tryAgent) {
      this.log('warn', 'Agent forwarding needs the agent enabled; forwarding will be inactive');
    }

    // Keepalives. WinSCP's "null packet" and "dummy command" both map onto
    // ssh2's protocol-level keepalive; only "off" disables it.
    const pingType = s.pingType || 'off';
    if (pingType !== 'off' && Number(s.pingInterval) > 0) {
      cfg.keepaliveInterval = Number(s.pingInterval) * 1000;
      cfg.keepaliveCountMax = 3;
    }

    // Algorithms.
    const algorithms = {};
    const cipher = algorithmList(s.cipherList, CIPHERS, SUPPORTED && SUPPORTED.cipher);
    const kex = algorithmList(s.kexList, KEXES, SUPPORTED && SUPPORTED.kex);
    requireAlgorithmPolicy('cipher', s.cipherList, cipher, sock);
    requireAlgorithmPolicy('key exchange', s.kexList, kex, sock);
    if (cipher && cipher.list.length) algorithms.cipher = cipher.list;
    if (kex && kex.list.length) algorithms.kex = kex.list;

    // Host keys get PuTTY's three-pass ordering rather than a flat expansion:
    // an algorithm we already hold a key for is offered ahead of one we do not,
    // so a server with several key types does not make the user verify a second
    // fingerprint for a host they have already trusted.
    const hostKey = this._hostKeyOrder(profile);
    requireAlgorithmPolicy('host-key', s.hostKeyList, hostKey, sock);
    if (hostKey.list.length) algorithms.serverHostKey = hostKey.list;
    if (hostKey.belowWarnThreshold.length) {
      this.log('debug', `Not offering host key ${hostKey.belowWarnThreshold.join(', ')} — below the warning threshold`);
    }
    if (hostKey.dropped.length) {
      this.log('debug', `Not offering host key ${hostKey.dropped.join(', ')} — this build's SSH library does not implement it`);
    }
    for (const [what, res] of [['cipher', cipher], ['key exchange', kex]]) {
      if (res && res.dropped.length) {
        this.log('debug', `Not offering ${what} ${res.dropped.join(', ')} — unsupported or below the warning threshold`);
      }
    }
    if (SUPPORTED) {
      algorithms.compress = s.compression
        ? ['zlib@openssh.com', 'zlib', 'none']
        : ['none', 'zlib@openssh.com', 'zlib'];
    }
    if (Object.keys(algorithms).length) cfg.algorithms = algorithms;

    if (s.authGSSAPI || s.authGSSAPIKEX || s.gssapiFwdTGT) {
      // Honest refusal beats a silent downgrade the user never sees.
      this.log('warn', 'GSSAPI/Kerberos authentication is requested but this build\'s SSH library does not implement it; the remaining methods will be tried');
    }

    const auths = this._authOrder(profile);
    this._authenticating = true;
    cfg.authHandler = (methodsLeft, partialSuccess, callback) => {
      while (auths.length) {
        const next = auths.shift();
        if (methodsLeft && !methodsLeft.includes(next.type === 'agent' ? 'publickey' : next.type)) continue;
        this.log('debug', `${profile.label} authentication: trying ${next.label}`);
        this._authenticationLog.push(`Trying ${next.label}`);
        // Remembering that a *stored* credential was offered is what lets the
        // failure be reported as "authentication failed" rather than
        // "credentials were not specified" — the difference between telling the
        // user their password is wrong and telling them to type one.
        if (next.type === 'password' || next.type === 'publickey') this._storedCredentialsTried = true;
        return callback(next.auth);
      }
      this.log('error', `${profile.label} authentication: no methods left`);
      this._authenticationLog.push('No authentication methods left');
      return callback(false);
    };

    return new Promise((resolve, reject) => {
      const onError = (e) => { cleanup(); reject(e); };
      const onReady = () => {
        cleanup();
        this._authenticating = false;
        this.log('info', `${profile.label} authenticated as ${cfg.username}@${hostPort}`);
        resolve(client);
      };
      const cleanup = () => {
        client.removeListener('error', onError);
        client.removeListener('ready', onReady);
      };
      client.on('error', onError);
      client.on('ready', onReady);
      client.on('banner', (msg) => this._banner(profile, msg));
      client.on('handshake', (info) => {
        if (profile.label === 'session' && info && info.serverHostKey) {
          this.hostKeyAlgorithm = info.serverHostKey;
          this.log('debug', `Negotiated host key algorithm ${info.serverHostKey}`);
          const better = ext.betterHostKeyAlgorithms(
            this._lastHostKeyOrder || [], info.serverHostKey, this._hasCachedHostKey(profile));
          if (better.length) {
            // PuTTY's cross-certification hint: the user prefers these more,
            // but has no key for them, so the next connection may well pick a
            // different type and ask about a fingerprint all over again.
            this.log('info', `No host key is known for the preferred algorithm(s) ${better.join(', ')}; the server chose ${info.serverHostKey}`);
          }
        }
      });
      client.on('close', () => {
        if (profile.label === 'session') { this.connected = false; this.emit('close'); }
      });
      client.connect(cfg);
    });
  }

  /**
   * PuTTY's host-key preference resolution, driven by the site's own list and
   * by whichever key types we already trust for this host.
   */
  _hostKeyOrder(profile) {
    const s = this.session;
    const supported = (SUPPORTED && SUPPORTED.serverHostKey) || null;
    const resolved = ext.resolveHostKeyOrder(s.hostKeyList, {
      supported,
      preferKnown: s.preferKnownHostKeys !== false,
      acceptCertificates: !!s.acceptHostKeyCertificates,
      hasCachedKey: this._hasCachedHostKey(profile),
    });
    this._lastHostKeyOrder = resolved.order;
    return resolved;
  }

  /**
   * "Do we already trust a key of this type for this host?" — from the site's
   * configured fingerprint and from whatever known-hosts store the caller
   * injected. Answering `false` is always safe; it only costs an extra prompt.
   */
  _hasCachedHostKey(profile) {
    const configured = String(profile.knownHostKey || '').split(/[;,]/).map((v) => v.trim()).filter(Boolean);
    const types = new Set();
    for (const fp of configured) {
      const type = ext.keyTypeFromFingerprint(fp);
      if (type) types.add(type);
    }
    const lookup = this.options.knownHostKeyTypes;
    if (typeof lookup === 'function') {
      let extra = [];
      try { extra = lookup(`${profile.host}:${profile.port}`) || []; } catch { extra = []; }
      for (const t of extra) types.add(t);
    }
    return (algorithm) => types.has(algorithm);
  }

  /**
   * `TSecureShell::DisplayBanner`. A banner that is only whitespace is dropped —
   * PuTTY calls back with a bare CRLF when the real banner had none, and
   * showing the user an empty dialog is worse than showing nothing.
   */
  _banner(profile, message) {
    const text = String(message == null ? '' : message);
    if (!text.trim()) return;
    this.banners.push({ leg: profile.label, text });
    this.log('info', `Server banner: ${text.trim()}`);
    const policy = this.options.bannerPolicy;
    const sessionKey = this.options.sessionKey || `${profile.host}:${profile.port}`;
    let show = true;
    if (policy && typeof policy.shouldShow === 'function') {
      try { show = policy.shouldShow(sessionKey, text); } catch { show = true; }
    }
    // The established `banner` contract across this app is the banner TEXT:
    // session.js forwards the first argument straight to the renderer, which
    // puts it in a notification and a <pre>. Emitting the decision object as
    // the first argument would put "[object Object]" in front of the user, so
    // the text leads and the decision rides along as a second argument for a
    // listener that wants it.
    this.emit('banner', text, { leg: profile.label, sessionKey, show, hash: ext.bannerHash(text) });
  }

  /** WinSCP's order: none, agent keys, a key file, keyboard-interactive, password. */
  _authOrder(profile) {
    const s = this.session;
    const username = profile.username || os.userInfo().username;
    const list = [];
    if (s.sshNoUserAuth) list.push({ type: 'none', label: '"none"', auth: { type: 'none', username } });

    if (s.tryAgent) {
      const agent = agentPath();
      if (agent) list.push({ type: 'agent', label: `the SSH agent (${agent === 'pageant' ? 'Pageant' : agent})`, auth: { type: 'agent', username, agent } });
      else this.log('debug', 'No SSH agent is reachable on this host');
    }

    if (profile.publicKeyFile) {
      let key = null;
      try { key = fs.readFileSync(profile.publicKeyFile); } catch (e) {
        this.log('error', `The key file could not be read: ${e.message}`);
      }
      if (key) {
        list.push({
          type: 'publickey',
          label: `the key file ${profile.publicKeyFile}`,
          auth: { type: 'publickey', username, key, passphrase: profile.passphrase || undefined },
        });
      }
    }

    if (s.authKI) {
      list.push({
        type: 'keyboard-interactive',
        label: 'keyboard-interactive',
        auth: {
          type: 'keyboard-interactive',
          username,
          prompt: (name, instructions, lang, prompts, finish) =>
            this._keyboardInteractive(profile, name, instructions, lang, prompts, finish),
        },
      });
    }

    if (profile.password) {
      list.push({ type: 'password', label: 'a password', auth: { type: 'password', username, password: profile.password } });
    }
    return list;
  }

  /**
   * Keyboard-interactive. When the site allows it, a single non-echoed prompt
   * is answered with the stored password (WinSCP's authKIPassword); anything
   * else has to go to the user, and with no prompt handler injected the attempt
   * fails rather than guessing.
   */
  _keyboardInteractive(profile, name, instructions, lang, prompts, finish) {
    const s = this.session;
    const list = prompts || [];
    if (s.authKIPassword && profile.password && list.length === 1 && list[0].echo === false) {
      this.log('debug', 'Answering the keyboard-interactive password prompt from the stored password');
      this._storedCredentialsTried = true;
      return finish([profile.password]);
    }
    // WinSCP ignores a request with no instructions and no prompts outright,
    // rather than putting an empty dialog in front of the user.
    if (!list.length && !String(instructions || '').trim()) {
      this.log('debug', 'Ignoring empty SSH server authentication request');
      return finish([]);
    }
    const handler = this.options.keyboardInteractive;
    if (typeof handler !== 'function') {
      this.log('error', 'The server asked an interactive question and no prompt handler is available');
      this._authenticationCancelled = true;
      return finish([]);
    }
    Promise.resolve(handler({ name, instructions, lang, prompts: list, host: profile.host, port: profile.port }))
      .then((answers) => {
        if (!Array.isArray(answers)) this._authenticationCancelled = true;
        finish(Array.isArray(answers) ? answers : []);
      })
      .catch((e) => {
        this.log('error', `The interactive prompt failed: ${e.message}`);
        this._authenticationCancelled = true;
        finish([]);
      });
  }

  /**
   * ssh2 rekeys on its own RFC schedule and exposes no configuration, so the
   * site's rekey time and data volume are enforced from here by asking the
   * protocol to rekey when either budget is spent.
   */
  _startRekeyPolicy() {
    const s = this.session;
    const proto = this.client && this.client._protocol;
    if (!proto || typeof proto.rekey !== 'function') {
      this.log('debug', 'This SSH library does not expose an explicit rekey; its own schedule applies');
      return;
    }
    const rekey = () => {
      try { proto.rekey(); this.log('debug', 'Requested a key re-exchange'); }
      catch (e) { this.log('debug', `Rekey request refused: ${e.message}`); }
    };
    const minutes = Number(s.rekeyTime);
    if (minutes > 0) this._rekeyTimer = setInterval(rekey, minutes * 60000).unref();

    const budget = parseDataSize(s.rekeyData);
    if (budget > 0 && this.socket) {
      this._rekeyBytes = 0;
      const check = () => {
        const moved = (this.socket.bytesRead || 0) + (this.socket.bytesWritten || 0);
        if (moved - this._rekeyBytes >= budget) { this._rekeyBytes = moved; rekey(); }
      };
      this._rekeyDataTimer = setInterval(check, 5000).unref();
    }
  }

  /** Run a command, buffering its output. */
  exec(command, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('Not connected'));
      this.log('debug', `exec: ${command}`);
      this.client.exec(command, { pty: !!opts.pty, env: opts.env }, (err, stream) => {
        if (err) return reject(err);
        const max = opts.maxBuffer || 64 * 1024 * 1024;
        const out = []; const errOut = [];
        let outLen = 0; let errLen = 0;
        let code = null; let signal = null; let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const stdout = Buffer.concat(out).toString(opts.encoding || 'utf8');
          const stderr = Buffer.concat(errOut).toString(opts.encoding || 'utf8');
          this.log('debug', `exec exit ${code === null ? 'unknown' : code}${signal ? ' (' + signal + ')' : ''}`);
          resolve({ code, signal, stdout, stderr });
        };
        stream.on('data', (d) => {
          outLen += d.length;
          if (outLen > max) { stream.destroy(); return reject(new Error('The command produced more output than allowed')); }
          out.push(d);
          if (opts.onStdout) opts.onStdout(d);
        });
        stream.stderr.on('data', (d) => {
          errLen += d.length;
          if (errLen <= max) errOut.push(d);
          if (opts.onStderr) opts.onStderr(d);
        });
        stream.on('exit', (c, sig) => { code = c; signal = sig || null; });
        stream.on('close', (c, sig) => {
          if (c !== undefined && c !== null) code = c;
          if (sig) signal = sig;
          finish();
        });
        stream.on('error', (e) => { if (!done) { done = true; reject(e); } });
        if (opts.stdin !== undefined) stream.end(opts.stdin);
      });
    });
  }

  /** Raw exec channel, for protocols that speak over the stream (SCP). */
  execRaw(command, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('Not connected'));
      this.log('debug', `exec: ${command}`);
      this.client.exec(command, { pty: !!opts.pty, env: opts.env }, (err, stream) => {
        if (err) reject(err); else resolve(stream);
      });
    });
  }

  sftp() {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('Not connected'));
      this.client.sftp((err, sftp) => { if (err) reject(err); else resolve(sftp); });
    });
  }

  async disconnect() {
    // From here an error from the server is noise about something the user has
    // already finished with — WinSCP's PuttyFatalError logs and drops it.
    this._closing = true;
    if (this._rekeyTimer) { clearInterval(this._rekeyTimer); this._rekeyTimer = null; }
    if (this._rekeyDataTimer) { clearInterval(this._rekeyDataTimer); this._rekeyDataTimer = null; }
    this.connected = false;
    try { if (this.client) this.client.end(); } catch { /* already down */ }
    try { if (this.tunnelServer) this.tunnelServer.close(); } catch { /* already down */ }
    try { if (this.tunnelClient) this.tunnelClient.end(); } catch { /* already down */ }
    this.client = null; this.tunnelClient = null; this.tunnelServer = null;
  }
}

/** '1G', '512M', '0' — WinSCP's rekey data limit, in bytes. */
function parseDataSize(v) {
  if (typeof v === 'number') return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i.exec(String(v || ''));
  if (!m) return 0;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

// ------------------------------------------------------------------ adapter

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;

function rightsFromMode(mode) {
  const bit = (v, c) => ((v & 1) ? c : '-');
  const trio = (v) => bit(v >> 2, 'r') + bit(v >> 1, 'w') + bit(v, 'x');
  const s = (trio((mode >> 6) & 7) + trio((mode >> 3) & 7) + trio(mode & 7)).split('');
  if (mode & 0o4000) s[2] = s[2] === 'x' ? 's' : 'S';
  if (mode & 0o2000) s[5] = s[5] === 'x' ? 's' : 'S';
  if (mode & 0o1000) s[8] = s[8] === 'x' ? 't' : 'T';
  return s.join('');
}

function parseRights(rights) {
  const s = String(rights || '').trim();
  if (/^0?[0-7]{3,4}$/.test(s)) return parseInt(s, 8);
  if (!/^[-rwxsStT]{9}$/.test(s)) return null;
  let mode = 0;
  const bits = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1];
  for (let i = 0; i < 9; i++) if (s[i] !== '-') mode |= bits[i];
  if (s[2] === 's' || s[2] === 'S') { mode |= 0o4000; if (s[2] === 'S') mode &= ~0o100; }
  if (s[5] === 's' || s[5] === 'S') { mode |= 0o2000; if (s[5] === 'S') mode &= ~0o10; }
  if (s[8] === 't' || s[8] === 'T') { mode |= 0o1000; if (s[8] === 'T') mode &= ~0o1; }
  return mode;
}

/** `ls -l`-style long name, when the server sends one, carries the *names* of
 *  the owner and group; the attribute block only carries their numeric ids. */
function ownerFromLongname(longname) {
  if (!longname) return null;
  const t = String(longname).trim().split(/\s+/);
  if (t.length < 6 || !/^\d+$/.test(t[1])) return null;
  // Some servers omit the group column, which puts the size where the group
  // would be; the month name that follows is what tells the two apart.
  const numeric = (v) => /^\d+$/.test(v || '');
  const hasGroup = !(numeric(t[3]) && !numeric(t[4]));
  return { owner: t[2] || '', group: hasGroup ? (t[3] || '') : '' };
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/**
 * SFTP 3 declares its timestamps unsigned, and almost every server writes them
 * signed — which is how OpenSSH stores a date before 1970. Read unsigned, such
 * a file's modification time comes back as some day in 2106 instead, and the
 * synchronizer then copies it in the wrong direction forever.
 *
 * WinSCP enables this reading for every SFTP 3 server (`sbSignedTS`, on by
 * default) because the failure only shows up on the rare file that has such a
 * date, and reading a *legitimate* post-2038 timestamp as negative is the same
 * mistake in the other direction — one WinSCP accepts, since no SFTP 3 server
 * can express such a date anyway.
 */
function signedSeconds(value) {
  const n = Number(value) || 0;
  return n >= 2147483648 && n <= 4294967295 ? n - 4294967296 : n;
}

/**
 * Normalize the two shapes a caller can hand `setTimes()`.
 *
 * The IPC layer calls it positionally — `setTimes(path, mtime, atime)` — while
 * the transfer queue and the synchronizer call it with an object, because that
 * is what "preserve timestamps" needs to pass around. An adapter that
 * understands only one of them does not fail loudly: `Number({mtime})` is NaN,
 * so every transferred file quietly gets a broken date, and a synchronized
 * tree never converges because the timestamps never match.
 *
 * Returns epoch milliseconds; the caller converts to whatever its wire wants.
 */
function normalizeTimes(mtime, atime) {
  const ms = (v) => (v instanceof Date ? v.getTime() : Number(v));
  const isObject = mtime !== null && typeof mtime === 'object' && !(mtime instanceof Date);
  const m = ms(isObject ? mtime.mtime : mtime);
  const rawA = isObject ? mtime.atime : atime;
  const a = rawA === undefined || rawA === null ? m : ms(rawA);
  if (!Number.isFinite(m)) {
    throw new Error('setTimes() needs a modification time in epoch milliseconds');
  }
  return { mtime: m, atime: Number.isFinite(a) ? a : m };
}

/** Keep a user-selected request window finite even when a hand-edited session
 * contains an absurd value. One SFTP packet per slot is the memory bound. */
function streamQueueDepth(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(256, n));
}

function validateStreamOffset(value, name) {
  if (value === undefined) return undefined;
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`SFTP ${name} must be a non-negative safe integer`);
  }
  return offset;
}

/**
 * Read several fixed ranges at once, but publish them in file order. ssh2's
 * built-in ReadStream deliberately reads one range at a time; this adapter
 * needs the same resumable stream contract with WinSCP's bounded queue depth.
 */
class PipelinedReadStream extends Readable {
  constructor(sftp, path, options = {}) {
    const highWaterMark = Number(options.highWaterMark) > 0
      ? Number(options.highWaterMark) : 64 * 1024;
    super({ highWaterMark, autoDestroy: options.autoClose !== false });
    this.sftp = sftp;
    this.path = path;
    this.flags = options.flags === undefined ? 'r' : options.flags;
    this.mode = options.mode === undefined ? 0o666 : options.mode;
    this.autoClose = options.autoClose !== false;
    this.handle = null;
    this._opening = true;
    this._stopped = false;
    this._ending = false;
    this._blocked = false;
    this._inflight = 0;
    this._ready = new Map();
    this._nextRequest = Number(options.start) > 0 ? Number(options.start) : 0;
    this._nextEmit = this._nextRequest;
    this._end = Number.isFinite(options.end) ? Number(options.end) : Infinity;
    this._eofAt = null;
    this._concurrency = streamQueueDepth(options.concurrency);
    const serverMax = Number(sftp._maxReadLen);
    this._chunkSize = Math.max(1, Math.min(highWaterMark,
      Number.isFinite(serverMax) && serverMax > 0 ? serverMax : highWaterMark));
    if (this._nextRequest < 0 || this._end < 0 || this._nextRequest > this._end + 1) {
      throw new RangeError('SFTP stream positions must be non-negative and ordered');
    }
    this._open();
  }

  _open() {
    this.sftp.open(this.path, this.flags, this.mode, (err, handle) => {
      this._opening = false;
      if (err) return this.destroy(err);
      if (this.destroyed || this._stopped) {
        return this.sftp.close(handle, () => {});
      }
      this.handle = handle;
      this.emit('open', handle);
      this.emit('ready');
      this._pump();
    });
  }

  _read() {
    if (this._ending || this.destroyed) return;
    this._blocked = false;
    this._emitReady();
    this._pump();
  }

  _fail(err) {
    if (!this._stopped && !this.destroyed) this.destroy(err);
  }

  _emitReady() {
    while (!this._ending && this._ready.has(this._nextEmit)) {
      const result = this._ready.get(this._nextEmit);
      this._ready.delete(this._nextEmit);

      if (this._eofAt !== null && result.position >= this._eofAt) continue;
      const limit = this._eofAt === null
        ? result.bytes
        : Math.min(result.bytes, Math.max(0, this._eofAt - result.position));
      if (limit > 0) {
        const data = result.data.subarray(0, limit);
        this._nextEmit += data.length;
        if (!this.push(data)) {
          this._blocked = true;
          return;
        }
      }
      if (this._eofAt !== null && this._nextEmit >= this._eofAt) {
        this._ending = true;
        this.push(null);
        return;
      }
    }

    if (!this._ending && this._eofAt !== null && this._nextEmit >= this._eofAt) {
      this._ending = true;
      this.push(null);
    }
  }

  _pump() {
    if (this._ending || this._blocked || this.destroyed || !this.handle) return;
    this._emitReady();
    while (!this._ending && !this._blocked &&
           this._inflight + this._ready.size < this._concurrency) {
      if (this._eofAt !== null) break;
      if (this._nextRequest > this._end) {
        this._eofAt = this._end + 1;
        break;
      }

      const position = this._nextRequest;
      const length = Math.min(this._chunkSize, this._end - position + 1);
      if (length <= 0) {
        this._eofAt = position;
        break;
      }
      const buffer = Buffer.allocUnsafe(length);
      this._nextRequest += length;
      this._inflight++;
      this.sftp.read(this.handle, buffer, 0, length, position, (err, bytes, data) => {
        this._inflight--;
        if (this._stopped) return;
        // SSH_FX_EOF is the normal SFTP answer when a read reaches the end of
        // a file. ssh2 exposes the wire status as code 1; treating it like a
        // transport failure makes empty files (and the final speculative
        // read in a pipelined transfer) emit `error` instead of ending cleanly.
        if (err && err.code !== 1) return this._fail(err);

        const count = Math.max(0, Math.min(Number(bytes) || 0, length));
        // SFTP servers normally report EOF as either status EOF or a zero-byte
        // DATA reply. A short DATA reply is also the only safe boundary when
        // requests are already in flight: later speculative ranges are dropped.
        if (err || count < length) {
          const boundary = position + count;
          this._eofAt = this._eofAt === null ? boundary : Math.min(this._eofAt, boundary);
        }
        this._ready.set(position, {
          position,
          bytes: count,
          data: Buffer.isBuffer(data) ? data : buffer.subarray(0, count),
        });
        this._emitReady();
        this._pump();
      });
    }
    this._emitReady();
  }

  _destroy(err, cb) {
    this._stopped = true;
    this._ready.clear();
    const handle = this.handle;
    this.handle = null;
    if (!handle) return cb(err);
    this.sftp.close(handle, (closeErr) => cb(err || closeErr));
  }
}

/**
 * Split each incoming write into bounded SFTP WRITE requests and keep at most
 * the configured number outstanding. The Writable callback is held until the
 * complete incoming chunk has landed, so normal stream backpressure remains
 * intact while the wire requests overlap.
 */
class PipelinedWriteStream extends Writable {
  constructor(sftp, path, options = {}) {
    const highWaterMark = Number(options.highWaterMark) > 0
      ? Number(options.highWaterMark) : 64 * 1024;
    super({ highWaterMark, autoDestroy: options.autoClose !== false });
    this.sftp = sftp;
    this.path = path;
    this.flags = options.flags === undefined ? 'w' : options.flags;
    this.mode = options.mode === undefined ? 0o666 : options.mode;
    this.autoClose = options.autoClose !== false;
    this.handle = null;
    this._opening = true;
    this._stopped = false;
    this._failed = false;
    this._job = null;
    this._active = 0;
    this._finalCb = null;
    this._position = Number(options.start) > 0 ? Number(options.start) : 0;
    this._resuming = this._position > 0 && options.start !== undefined;
    this._modeExplicit = options.mode !== undefined;
    this.bytesWritten = 0;
    this._concurrency = streamQueueDepth(options.concurrency);
    const serverMax = Number(sftp._maxWriteLen);
    this._chunkSize = Math.max(1, Math.min(highWaterMark,
      Number.isFinite(serverMax) && serverMax > 0 ? serverMax : highWaterMark));
    if (this._position < 0) throw new RangeError('SFTP stream positions must be non-negative');
    this._open();
  }

  _open() {
    this.sftp.open(this.path, this.flags, this.mode, (err, handle) => {
      this._opening = false;
      if (err) return this.destroy(err);
      if (this.destroyed || this._stopped) {
        return this.sftp.close(handle, () => {});
      }
      this.handle = handle;
      const ready = () => {
        if (this.destroyed || this._stopped) return this.sftp.close(handle, () => {});
        this.emit('open', handle);
        this.emit('ready');
      };
      const setMode = () => {
        // A resumed upload reopens an existing file. Applying the stream's
        // default mode (0666) here changes its permissions as a side effect
        // of continuing the transfer; preserve the remote mode unless the
        // caller explicitly supplied one.
        if (this._resuming && !this._modeExplicit) return ready();
        if (typeof this.sftp.fchmod !== 'function') return ready();
        this.sftp.fchmod(handle, this.mode, (modeErr) => {
          if (!modeErr) return ready();
          if (typeof this.sftp.chmod !== 'function') return ready();
          this.sftp.chmod(this.path, this.mode, () => ready());
        });
      };
      if (this.flags[0] === 'a' && typeof this.sftp.fstat === 'function') {
        this.sftp.fstat(handle, (statErr, stat) => {
          if (!statErr) { this._position = Number(stat.size) || 0; return setMode(); }
          if (typeof this.sftp.stat !== 'function') return this.destroy(statErr);
          this.sftp.stat(this.path, (fallbackErr, fallback) => {
            if (fallbackErr) return this.destroy(statErr);
            this._position = Number(fallback.size) || 0;
            setMode();
          });
        });
      } else {
        setMode();
      }
    });
  }

  _write(data, encoding, cb) {
    if (!Buffer.isBuffer(data)) return cb(new TypeError('SFTP writes need Buffer data'));
    if (!this.handle) return this.once('ready', () => this._write(data, encoding, cb));
    const chunks = [];
    for (let offset = 0; offset < data.length; offset += this._chunkSize) {
      chunks.push(data.subarray(offset, Math.min(data.length, offset + this._chunkSize)));
    }
    if (!chunks.length) return cb();
    this._job = { chunks, index: 0, remaining: chunks.length, cb };
    this._pumpWrites();
  }

  _pumpWrites() {
    const job = this._job;
    if (!job || this._failed || this._stopped || !this.handle) return;
    while (job.index < job.chunks.length && this._active < this._concurrency) {
      const data = job.chunks[job.index++];
      const position = this._position;
      this._position += data.length;
      this._active++;
      this.sftp.write(this.handle, data, 0, data.length, position, (err) => {
        this._active--;
        if (this._stopped || this._failed) return;
        if (err) {
          this._failed = true;
          this._job = null;
          job.cb(err);
          return this.destroy(err);
        }
        this.bytesWritten += data.length;
        job.remaining--;
        if (job.remaining === 0) {
          this._job = null;
          job.cb();
        }
        if (this._active === 0 && !this._job && this._finalCb) {
          const done = this._finalCb;
          this._finalCb = null;
          done();
        }
        this._pumpWrites();
      });
    }
  }

  _fail(err) {
    if (!this._stopped && !this.destroyed) this.destroy(err);
  }

  _final(cb) {
    if (this._active === 0 && !this._job) return cb();
    this._finalCb = cb;
  }

  _destroy(err, cb) {
    this._stopped = true;
    const handle = this.handle;
    this.handle = null;
    if (!handle) return cb(err);
    this.sftp.close(handle, (closeErr) => cb(err || closeErr));
  }
}

class SftpAdapter extends Adapter {
  /**
   * @param session  resolved session data
   * @param options  { hostKeyVerifier, keyboardInteractive, transport }
   */
  constructor(session, options = {}) {
    super(session);
    this.options = options;
    this.transport = options.transport || null;
    this.sftp = null;
    this._streams = new Set();
    this._streamChannelError = null;
    this._streamChannelClose = null;
    this.extensions = {};
    this.caps = {
      ...this.caps,
      rights: true,
      owner: true,
      symlink: true,
      hardlink: false,
      exec: true,
      resume: true,
      timestamp: true,
      recycleBin: false,
      checksum: true,
      find: true,
      rename: true,
      move: true,
      copyRemote: false,
      calculateSize: true,
      nativeMove: true,
      hiddenFiles: true,
      spaceInfo: false,
    };
  }

  get protocolName() { return 'SFTP'; }

  _log(level, message) { this.emit('log', { level, message }); }

  /** A wire timestamp in seconds, read the way this server writes them. */
  _seconds(value) {
    if (this.bugs && this.bugs.signedTimestamps) return signedSeconds(value);
    return Number(value) || 0;
  }

  /**
   * The read/write packet size for the streaming path. The site's own setting
   * wins; otherwise the server's own ceiling applies, because a packet above it
   * is dropped and the transfer then stalls with nothing in the log to say why.
   */
  _packetSize() {
    const configured = Number(this.session.sftpMaxPacketSize) || 0;
    if (configured > 0) return configured;
    return (this.maxPacketSize && this.maxPacketSize.size) || 0;
  }

  // ---- lifecycle -------------------------------------------------------
  async connect() {
    if (!this.transport) {
      this.transport = new SshTransport(this.session, this.options);
      this._ownsTransport = true;
    }
    this.transport.on('log', (e) => this.emit('log', e));
    this.transport.on('banner', (text, info) => this.emit('banner', text, info));
    this.transport.on('close', () => { this.connected = false; this.emit('close'); });
    // The SSH_FXP_VERSION reply arrives before any caller can reach the SFTP
    // channel, so the observer that captures its raw extension bytes has to be
    // in place before the channel is opened.
    ext.installTapSupport();
    if (!this.transport.connected) await this.transport.connect();

    this.sftp = await this.transport.sftp();
    this.sftp.on('error', (e) => this._log('error', `SFTP channel error: ${e.message}`));
    this._streamChannelError = (err) => this._failStreams(err);
    this._streamChannelClose = () => this._failStreams(new Error('SFTP channel closed while a stream was active'));
    this.sftp.on('error', this._streamChannelError);
    this.sftp.on('close', this._streamChannelClose);
    this.sftp.on('end', this._streamChannelClose);
    this.extensions = this.sftp._extensions || {};

    const ident = this.transport.sshImplementation;
    const implementation = ext.detectSshImplementation(ident);
    const vendor = ext.detectServerVendor(ident);
    const version = Number.isFinite(this.sftp._version) ? this.sftp._version : 3;
    this.sftpVersion = ext.checkNegotiatedVersion(version);
    this.sshImplementation = ident;
    this.implementation = implementation;

    const requested = ext.resolveMaxSftpVersion(this.session.sftpMaxVersion, implementation);
    if (version > requested) {
      // ProFTPD issue 1200 answers with a higher version than it was asked for.
      this._log('debug', 'Got higher version than asked for.');
    }

    // The raw VERSION bytes when the observer is in place, ssh2's UTF-8-decoded
    // copy otherwise. The second is lossy for binary values, which is why the
    // parser is told which one it received.
    const raw = ext.rawVersionExtensions(this.sftp);
    this.serverCaps = ext.parseServerExtensions(raw || this.extensions, {
      version: this.sftpVersion,
      log: (level, message) => this._log(level, message),
    });

    this.ext = new ext.SftpExtensions(this.sftp, {
      caps: this.serverCaps,
      implementation,
      log: (level, message) => this._log(level, message),
    });

    this.bugs = ext.resolveSftpBugs({
      implementation,
      ident,
      version: this.sftpVersion,
      bugs: this.session.sftpBugs || {},
      notUtf: this.session.notUtf,
      supportLoaded: this.serverCaps.support.loaded,
    });
    this.serverAbilities = ext.resolveCapabilities({
      caps: this.serverCaps,
      implementation,
      version: this.sftpVersion,
      encrypting: !!this.session.encryptFiles,
    });

    const names = this.serverCaps.names;
    if (names.length) this._log('debug', `Server SFTP extensions: ${names.join(', ')}`);
    if (implementation !== 'unknown' || vendor !== 'unknown') {
      this._log('debug', `Server identified as ${ident} (${vendor})`);
    }
    for (const bug of this.bugs.active) {
      this._log('debug', `Applying workaround for ${bug.server}: ${bug.workaround}`);
    }

    // The packet ceiling comes from the server's own limits@openssh.com when it
    // offers one — a packet above it is dropped, and the transfer then stalls
    // with nothing in the log to say why.
    this.serverLimits = null;
    if (this.serverCaps.limitsV1 || implementation === 'bitvise') {
      try { this.serverLimits = await this.ext.limits({ timeoutMs: this.transport.timeoutMs }); }
      catch (e) { this._log('debug', `limits@openssh.com refused: ${e.message}`); }
    }
    this.maxPacketSize = ext.resolveMaxPacketSize({
      configured: this.session.sftpMaxPacketSize,
      limits: this.serverLimits,
      implementation,
      version: this.sftpVersion,
      supportLoaded: this.serverCaps.support.loaded,
      ident,
    });
    if (this.maxPacketSize.size > 0) {
      this._log('debug', `Limiting packet size to ${this.maxPacketSize.size} bytes — ${this.maxPacketSize.reason}`);
    }

    this.caps.spaceInfo = this.serverAbilities.checkingSpaceAvailable;
    this.caps.hardlink = this.serverAbilities.hardLink;
    this.caps.copyRemote = this.serverAbilities.remoteCopy;
    this.caps.owner = this.serverAbilities.ownerChanging;
    this.caps.rights = this.serverAbilities.modeChanging;
    this.caps.symlink = this.serverAbilities.symbolicLink;
    // `checksum()` still falls back to a shell hash, so the capability stays
    // true when the server offers no hash extension but does offer a shell.
    this.caps.checksum = this.serverAbilities.calculatingChecksum || this.caps.exec;

    this.home = await this.realpath('.');
    // WinSCP's guard against a server that answers realpath with nothing:
    // without it the empty home is fed back into the next canonicalisation.
    if (!this.home) this.home = '/';
    this.connected = true;
    this.serverInfo = {
      protocol: 'SFTP',
      sftpVersion: this.sftpVersion,
      extensions: names,
      home: this.home,
      posixRename: this.serverAbilities.posixRename,
      implementation,
      vendor,
      sshImplementation: ident,
      software: this.serverCaps.vendor,
      eol: this.serverCaps.eol,
      fixedPaths: this.serverCaps.fixedPaths,
      limits: this.serverLimits,
      maxPacketSize: this.maxPacketSize.size,
      abilities: this.serverAbilities,
      workarounds: this.bugs.active,
      // Detected but NOT performed by this port — kept separate so the UI can
      // say "we know about this server's bug and do not handle it" rather than
      // implying it is handled.
      unhandledWorkarounds: this.bugs.documented,
      extendedRequests: this.ext.available,
    };
    this._log('info', `SFTP version ${this.sftpVersion} session ready; home directory ${this.home}`);
    return this.serverInfo;
  }

  async disconnect() {
    this.connected = false;
    const channel = this.sftp;
    this._failStreams(new Error('SFTP channel closed while a stream was active'));
    if (channel && this._streamChannelError) channel.removeListener('error', this._streamChannelError);
    if (channel && this._streamChannelClose) {
      channel.removeListener('close', this._streamChannelClose);
      channel.removeListener('end', this._streamChannelClose);
    }
    this._streamChannelError = null;
    this._streamChannelClose = null;
    this._streams.clear();
    try { if (channel) channel.end(); } catch { /* already down */ }
    this.sftp = null;
    if (this._ownsTransport && this.transport) await this.transport.disconnect();
    this.transport = null;
  }

  _call(method, ...args) {
    return new Promise((resolve, reject) => {
      if (!this.sftp) return reject(new Error('Not connected'));
      this._log('debug', `${method} ${args.filter((a) => typeof a === 'string' || typeof a === 'number').join(' ')}`);
      this.sftp[method](...args, (err, result) => {
        if (err) {
          this._log('debug', `${method} failed: ${err.message}`);
          reject(err);
        } else resolve(result);
      });
    });
  }

  // ---- reading ---------------------------------------------------------
  async list(dir) {
    const target = this.normalize(dir);
    const rows = await this._call('readdir', target);
    const resolveLinks = this.session.resolveSymlinks !== false;

    // '.' and '..' are navigation, not content; the panel synthesizes its own.
    const visible = rows.filter((row) => row.filename !== '.' && row.filename !== '..');

    const out = await Promise.all(visible.map(async (row) => {
      const a = row.attrs || {};
      const mode = a.mode || 0;
      const fmt = mode & S_IFMT;
      const isSymlink = fmt === S_IFLNK;
      let type = 'special';
      if (isSymlink) type = 'link';
      else if (fmt === S_IFDIR) type = 'dir';
      else if (fmt === S_IFREG || fmt === 0) type = 'file';

      let linkTarget = '';
      if (isSymlink && resolveLinks) {
        const full = this.join(target, row.filename);
        try { linkTarget = await this._call('readlink', full); } catch { /* dangling link */ }
        try {
          const st = await this._call('stat', full);
          type = (st.mode & S_IFMT) === S_IFDIR ? 'dir' : 'file';
        } catch { type = 'link'; }
      }

      const names = ownerFromLongname(row.longname);
      return entry({
        name: row.filename,
        type,
        size: Number(a.size) || 0,
        mtime: this._seconds(a.mtime) * 1000,
        rights: rightsFromMode(mode),
        owner: (names && names.owner) || (a.uid === undefined ? '' : String(a.uid)),
        group: (names && names.group) || (a.gid === undefined ? '' : String(a.gid)),
        linkTarget,
        isSymlink,
        hidden: row.filename.startsWith('.'),
        readOnly: !(mode & 0o200),
        raw: { mode, uid: a.uid, gid: a.gid, atime: this._seconds(a.atime) * 1000, longname: row.longname },
      });
    }));
    return out;
  }

  async stat(p) {
    const target = this.normalize(p);
    let lst;
    try {
      lst = await this._call('lstat', target);
    } catch (e) {
      // FTPShell Server rejects LSTAT outright.  STAT is a safe compatibility
      // fallback for this read-only probe, but it follows links, so do not
      // pretend the result contains link metadata we could not obtain.
      if (!this.bugs || !this.bugs.lstatUnsupported || !ext.isOperationUnsupported(e)) throw e;
      this._log('debug', `lstat(${target}) is unsupported; using stat() fallback`);
      const followed = await this._call('stat', target);
      const mode = followed.mode || 0;
      const followedType = (mode & S_IFMT) === S_IFDIR
        ? 'dir'
        : (mode & S_IFMT) === S_IFREG || (mode & S_IFMT) === 0 ? 'file' : 'special';
      return entry({
        name: this.basename(target),
        type: followedType,
        size: Number(followed.size) || 0,
        mtime: this._seconds(followed.mtime) * 1000,
        rights: rightsFromMode(mode),
        owner: followed.uid === undefined ? '' : String(followed.uid),
        group: followed.gid === undefined ? '' : String(followed.gid),
        hidden: this.basename(target).startsWith('.'),
        readOnly: !(mode & 0o200),
        raw: { path: target, mode, uid: followed.uid, gid: followed.gid, atime: this._seconds(followed.atime) * 1000, lstatFallback: true },
      });
    }
    const mode = lst.mode || 0;
    const isSymlink = (mode & S_IFMT) === S_IFLNK;
    let type = isSymlink ? 'link' : ((mode & S_IFMT) === S_IFDIR ? 'dir' : 'file');
    let size = Number(lst.size) || 0;
    let linkTarget = '';
    if (isSymlink) {
      try { linkTarget = await this._call('readlink', target); } catch { /* dangling */ }
      try {
        const st = await this._call('stat', target);
        type = (st.mode & S_IFMT) === S_IFDIR ? 'dir' : 'file';
        size = Number(st.size) || 0;
      } catch { type = 'link'; }
    }
    return entry({
      name: this.basename(target),
      type,
      size,
      mtime: this._seconds(lst.mtime) * 1000,
      rights: rightsFromMode(mode),
      owner: lst.uid === undefined ? '' : String(lst.uid),
      group: lst.gid === undefined ? '' : String(lst.gid),
      linkTarget,
      isSymlink,
      hidden: this.basename(target).startsWith('.'),
      readOnly: !(mode & 0o200),
      raw: { path: target, mode, uid: lst.uid, gid: lst.gid, atime: this._seconds(lst.atime) * 1000 },
    });
  }

  /** WinSCP's sftpRealPath: 'off' skips the canonicalize round trip entirely. */
  async realpath(p) {
    if (this.session.sftpRealPath === 'off') return this.normalize(p);
    try { return this.normalize(await this._call('realpath', p || '.')); }
    catch (e) {
      this._log('debug', `realpath(${p}) failed: ${e.message}`);
      return this.normalize(p);
    }
  }

  async readlink(p) { return this._call('readlink', this.normalize(p)); }

  // ---- writing ---------------------------------------------------------
  async mkdir(p, opts = {}) {
    const target = this.normalize(p);
    if (opts.recursive) {
      const parts = target.split('/').filter(Boolean);
      let cur = target.startsWith('/') ? '' : '.';
      for (const part of parts) {
        cur = cur === '' ? '/' + part : cur + '/' + part;
        try { await this._call('mkdir', cur, {}); } catch (e) {
          const st = await this._call('stat', cur).catch(() => null);
          if (!st || (st.mode & S_IFMT) !== S_IFDIR) throw e;
        }
      }
      return target;
    }
    await this._call('mkdir', target, opts.attrs || {});
    return target;
  }

  async remove(p, opts = {}) {
    const target = this.normalize(p);
    const lst = await this._call('lstat', target);
    const isDir = (lst.mode & S_IFMT) === S_IFDIR;
    if (!isDir) { await this._call('unlink', target); return; }
    if (!opts.recursive) { await this._call('rmdir', target); return; }

    // SFTP has no recursive delete; the walk is the client's job.
    const stack = [target];
    const dirs = [];
    while (stack.length) {
      const dir = stack.pop();
      dirs.push(dir);
      const rows = await this._call('readdir', dir);
      for (const row of rows) {
        const child = this.join(dir, row.filename);
        let mode = (row.attrs && row.attrs.mode) || 0;
        // SFTP permits servers to omit attributes from directory entries. In
        // that case, do an lstat rather than guessing from a zero mode. Using
        // lstat is important: stat would follow a symlink to a directory and
        // recursive removal would then walk outside the requested tree.
        if (!mode) {
          const childAttrs = await this._call('lstat', child);
          mode = childAttrs.mode || 0;
        }
        if ((mode & S_IFMT) === S_IFDIR) stack.push(child);
        else await this._call('unlink', child);
      }
    }
    for (let i = dirs.length - 1; i >= 0; i--) await this._call('rmdir', dirs[i]);
  }

  async rename(from, to) {
    const src = this.normalize(from);
    const dst = this.normalize(to);
    // POSIX rename replaces the target atomically; the plain SFTP one fails if
    // the target exists, which is why WinSCP offers the choice.
    if (this.session.usePosixRename && this.ext && this.ext.supports(ext.EXT.POSIX_RENAME)) {
      await this.ext.posixRename(src, dst);
      return dst;
    }
    await this._call('rename', src, dst);
    return dst;
  }

  /**
   * Create a symbolic link.
   *
   * The argument order is the whole subtlety here: OpenSSH implemented
   * SSH_FXP_SYMLINK with its two paths swapped relative to the specification,
   * ProFTPD copied that deliberately, and every other server got it right. Send
   * them the wrong way round to a correct server and the link is created *at*
   * the target path pointing at the link name — silently, with no error, which
   * is why it has to be decided from the server's identification rather than
   * discovered from a failure.
   */
  async symlink(target, linkPath) {
    const link = this.normalize(linkPath);
    // ssh2 makes the same decision, but from a different test: it reverses for
    // anything identifying as OpenSSH *or dropbear*. WinSCP reverses for
    // OpenSSH, Sun SSH (an OpenSSH fork) and ProFTPD/mod_sftp, which followed
    // the bug on purpose — but it has never heard of dropbear, whose SFTP
    // subsystem is in practice OpenSSH's own sftp-server and therefore wants
    // the reversed order too.
    //
    // The two lists are therefore UNIONED rather than one replacing the other:
    // taking WinSCP's answer alone would send the specification order to a
    // dropbear host, and SSH_FXP_SYMLINK with its arguments the wrong way round
    // does not fail — it creates the link at the target's path, silently. Only
    // an explicit `off` on the site's own bug switch overrides the union, which
    // is exactly what WinSCP's asOff means.
    const forced = String((this.session.sftpBugs || {}).symlink || 'auto').toLowerCase();
    const libraryReverses = !!(this.sftp && this.sftp._isOpenSSH);
    const winscpReverses = this.bugs ? this.bugs.symlinkArgumentOrderReversed : false;
    const reversed = forced === 'off' ? false
      : forced === 'on' ? true
        : (winscpReverses || libraryReverses);
    if (reversed !== libraryReverses) {
      this._log('debug', reversed
        ? 'We believe the server has the SFTP symlink bug; sending the target first'
        : 'The server follows the specification for SSH_FXP_SYMLINK; sending the link name first');
    }
    if (reversed === libraryReverses) await this._call('symlink', target, link);
    else await this._call('symlink', link, target);
  }

  /**
   * `hardlink@openssh.com`. The extension is *defined* with the reversed
   * argument order — deliberately, to mirror the symlink bug — so there is no
   * conforming spelling to fall back to.
   */
  async hardlink(existing, linkPath) {
    if (!this.ext) throw new Error('Not connected');
    if (!this.caps.hardlink) throw new Error('The server does not offer hard links');
    await this.ext.hardlink(this.normalize(existing), this.normalize(linkPath), {
      force: this.implementation === 'bitvise',
    });
  }

  /** Flush an open remote handle to the server's disk (`fsync@openssh.com`). */
  async fsync(handle) {
    if (!this.ext) throw new Error('Not connected');
    return this.ext.fsync(handle);
  }

  /**
   * Server-side copy, so a duplicate never travels to the client and back.
   *
   * `copy-file` is one request; `copy-data` needs both files open, which is why
   * the handles are taken here. Both refuse an existing target: `copy-file`
   * because ProFTPD and Bitvise implement it that way, and `copy-data` because
   * the destination is opened with SSH_FXF_EXCL to match — a remote copy that
   * silently overwrote on one server and refused on another would be the worst
   * of both.
   */
  async copyRemote(from, to, opts = {}) {
    if (!this.ext) throw new Error('Not connected');
    if (!this.caps.copyRemote) throw new Error('The server cannot copy files on the server side');
    const src = this.normalize(from);
    const dst = this.normalize(to);
    const force = this.implementation === 'bitvise';

    if (this.ext.supports(ext.EXT.COPY_FILE) || force) {
      await this.ext.copyFile(src, dst, { overwrite: !!opts.overwrite, force });
      return dst;
    }

    let readHandle = null;
    let writeHandle = null;
    let destinationCreated = false;
    let copied = false;
    try {
      readHandle = await this._call('open', src, 'r');
      writeHandle = await this._call('open', dst, 'wx');
      destinationCreated = true;
      await this.ext.copyData(readHandle, writeHandle, { length: 0 });
      copied = true;
    } finally {
      for (const h of [readHandle, writeHandle]) {
        if (h) { try { await this._call('close', h); } catch { /* the session may already be gone */ } }
      }
      // copy-data creates the destination before streaming bytes. Remove a
      // partial file when the server rejects the copy, so it cannot look
      // like a completed remote copy to the next operation.
      if (destinationCreated && !copied) {
        try { await this._call('unlink', dst); } catch { /* preserve the copy error */ }
      }
    }
    // WinSCP copies the source's permissions and modification time across,
    // because copy-data moves bytes and nothing else.
    if (opts.attrs !== false) {
      try {
        const st = await this._call('stat', src);
        if (st && st.mode !== undefined) await this._call('chmod', dst, st.mode & 0o7777);
        if (st && st.mtime !== undefined) {
          await this._call('utimes', dst, Number(st.atime) || Number(st.mtime), Number(st.mtime));
        }
      } catch (e) {
        this._log('debug', `Could not copy attributes to ${dst}: ${e.message}`);
      }
    }
    return dst;
  }

  async setRights(p, rights) {
    const mode = typeof rights === 'number' ? rights : parseRights(rights);
    if (mode === null) throw new Error(`"${rights}" is not a permission string or mode`);
    if (await this._applyToLink(p, { mode })) return;
    await this._call('chmod', this.normalize(p), mode);
  }

  /**
   * Plain SSH_FXP_SETSTAT FOLLOWS a symbolic link, so `chmod`/`utimes` on a
   * link rewrite the TARGET. That is wrong in both directions: "preserve
   * timestamps" on a downloaded tree stamps the wrong files, and a
   * synchronisation that keeps re-stamping the target never converges because
   * the link's own time never changes.
   *
   * `lsetstat@openssh.com` is the operation that does not follow the link.
   * Returns true when it did the work, false when the caller should fall back
   * to the ordinary request — an old server, or a path that is not a link.
   */
  async _applyToLink(p, attrs) {
    const target = this.normalize(p);
    if (!this.ext || typeof this.ext.supports !== 'function' || !this.ext.supports('lsetstat@openssh.com')) {
      return false;
    }
    let isLink = false;
    try { isLink = (await this._call('lstat', target)).isSymbolicLink(); } catch { return false; }
    if (!isLink) return false;
    await this.ext.lsetstat(target, attrs);
    return true;
  }

  async setOwner(p, uid, gid) {
    await this._call('chown', this.normalize(p), Number(uid), Number(gid));
  }

  /** Epoch milliseconds in, POSIX seconds on the wire. Both call shapes are
   *  accepted — see normalizeTimes(). */
  async setTimes(p, mtime, atime) {
    const t = normalizeTimes(mtime, atime);
    const atimeSec = Math.floor(t.atime / 1000);
    const mtimeSec = Math.floor(t.mtime / 1000);
    if (await this._applyToLink(p, { atime: atimeSec, mtime: mtimeSec })) return;
    await this._call('utimes', this.normalize(p), atimeSec, mtimeSec);
  }

  /** Return the configured bounded request window for one stream direction. */
  _streamConcurrency(direction) {
    const setting = direction === 'download' ? 'sftpDownloadQueue' : 'sftpUploadQueue';
    const requested = Math.floor(Number(this.session[setting]));
    const depth = streamQueueDepth(requested);
    if (requested > 256) {
      this._log('warn', `SFTP ${setting}=${requested} exceeds the safe adapter bound; using 256 outstanding requests`);
    }
    return depth;
  }

  // ---- streaming -------------------------------------------------------
  async createReadStream(p, opts = {}) {
    if (!this.sftp) throw new Error('Not connected');
    const target = this.normalize(p);
    const start = validateStreamOffset(opts.start, 'start offset');
    const end = validateStreamOffset(opts.end, 'end offset');
    const options = { autoClose: true };
    if (start !== undefined && start > 0) options.start = start;
    if (end !== undefined) options.end = end;
    // The stream's high-water mark *is* the SFTP read packet size in this
    // library, so the site's maximum packet size lands here.
    const hwm = opts.highWaterMark || this._packetSize();
    if (hwm > 0) options.highWaterMark = hwm;
    const concurrency = this._streamConcurrency('download');
    this._log('debug', `download ${target}${options.start ? ' from offset ' + options.start : ''} with ${concurrency} request(s) in flight`);
    return this._adopt(new PipelinedReadStream(this.sftp, target, {
      ...options,
      highWaterMark: hwm > 0 ? hwm : undefined,
      concurrency,
    }), `download ${target}`);
  }

  /**
   * Give every stream we hand out an owner-side 'error' listener.
   *
   * The channel can fail after the consumer has finished with the stream — the
   * classic case is the CLOSE request still in flight when the session is torn
   * down, which comes back as "No response from server". With no listener that
   * is an unhandled 'error' event, i.e. the whole main process goes down
   * because a file was read and then the user pressed Disconnect. Adding a
   * listener here does not hide anything: a consumer that attaches its own
   * still receives the event.
   */
  _adopt(stream, what) {
    this._streams.add(stream);
    stream.once('close', () => this._streams.delete(stream));
    stream.on('error', (e) => this._log('debug', `${what}: stream error after handover: ${e.message}`));
    return stream;
  }

  _failStreams(err) {
    for (const stream of this._streams) stream.destroy(err);
  }

  /** `start > 0` reopens the file for update so a partial upload continues
   *  where it stopped instead of starting again from zero. */
  async createWriteStream(p, opts = {}) {
    if (!this.sftp) throw new Error('Not connected');
    const target = this.normalize(p);
    const start = validateStreamOffset(opts.start, 'start offset') || 0;
    const options = { autoClose: true };
    if (start > 0) { options.flags = 'r+'; options.start = start; }
    else options.flags = opts.append ? 'a' : 'w';
    if (opts.mode !== undefined) options.mode = opts.mode;
    const hwm = opts.highWaterMark || this._packetSize();
    if (hwm > 0) options.highWaterMark = hwm;
    const concurrency = this._streamConcurrency('upload');
    this._log('debug', `upload ${target}${start ? ' from offset ' + start : ''} with ${concurrency} request(s) in flight`);
    return this._adopt(new PipelinedWriteStream(this.sftp, target, {
      ...options,
      concurrency,
    }), `upload ${target}`);
  }

  // ---- optional --------------------------------------------------------
  async exec(command, opts = {}) {
    if (!this.transport) throw new Error('Not connected');
    return this.transport.exec(command, opts);
  }

  /**
   * A file's hash, computed by the server.
   *
   * Three routes, in WinSCP's order of preference: `check-file` (the SFTP
   * extension, which negotiates the algorithm and works for an SFTP-only
   * account), `md5-hash` (OpenSSH's older single-algorithm request), and only
   * then a shell hash — which needs shell access the account may not have.
   *
   * A server that answers SSH_FX_OP_UNSUPPORTED has told us the extension is
   * not really there despite the advertisement, so the next route is tried.
   * Any other error is the server's answer and is reported, not swallowed.
   */
  async checksum(p, algorithm = 'sha256') {
    const target = this.normalize(p);
    const wire = ext.checksumAlgToWire(algorithm);
    const alg = wire.replace(/-/g, '');

    if (this.ext && this.serverAbilities && this.serverAbilities.calculatingChecksum) {
      try {
        const res = await this.ext.checkFile(target, {
          algorithms: [wire],
          force: this.implementation === 'bitvise',
        });
        if (res.hex) {
          if (res.algorithm && ext.checksumAlgToWire(res.algorithm) !== wire) {
            // The extension lets the server pick from the offered list; saying
            // which one it picked is the difference between a checksum the user
            // can compare and one they cannot.
            this._log('info', `The server computed ${res.algorithm} rather than ${wire}`);
          }
          return res.hex;
        }
      } catch (e) {
        if (!ext.isOperationUnsupported(e)) throw e;
        this._log('debug', `check-file refused: ${e.message}`);
      }
    }

    if (this.ext && alg === 'md5' && this.ext.supports(ext.EXT.MD5_HASH)) {
      try {
        const res = await this.ext.md5Hash(target);
        if (res.hex) return res.hex;
      } catch (e) {
        if (!ext.isOperationUnsupported(e)) throw e;
        this._log('debug', `md5-hash refused: ${e.message}`);
      }
    }

    if (!this.caps.exec) {
      throw new Error('The server offers no checksum extension and this account has no shell access');
    }
    const shellTools = {
      md5: 'md5sum',
      sha1: 'sha1sum',
      sha256: 'sha256sum',
      sha512: 'sha512sum',
    };
    const tool = shellTools[alg];
    if (!tool) {
      throw new Error(`The server offers no usable checksum path for ${algorithm}; shell fallback supports MD5, SHA-1, SHA-256 and SHA-512`);
    }
    const res = await this.transport.exec(`${tool} -- ${shellQuote(target)}`);
    if (res.code !== 0) throw new Error(`${tool} failed: ${(res.stderr || '').trim() || 'exit code ' + res.code}`);
    const hex = /^([0-9a-f]+)\s/i.exec(res.stdout.trim());
    if (!hex) throw new Error(`${tool} produced no usable output`);
    return hex[1].toLowerCase();
  }

  /**
   * Free space, from whichever extension the server offers.
   *
   * `space-available` is the standard one and is preferred, exactly as WinSCP
   * prefers it; `statvfs@openssh.com` is the fallback and carries a different
   * set of figures — notably no per-user quota, which is why
   * `availableToUser` is zero there rather than a guess.
   */
  async spaceInfo(p) {
    if (!this.ext || !this.caps.spaceInfo) return null;
    const target = this.normalize(p || this.home || '/');
    const force = this.implementation === 'bitvise';

    if (this.ext.supports(ext.EXT.SPACE_AVAILABLE) || force) {
      try {
        const s = await this.ext.spaceAvailable(target, { force });
        return {
          path: target,
          total: s.bytesOnDevice,
          free: s.unusedBytesAvailableToUser || s.unusedBytesOnDevice,
          used: s.bytesOnDevice - s.unusedBytesOnDevice,
          blockSize: s.bytesPerAllocationUnit,
          files: 0,
          filesFree: 0,
          quotaTotal: s.bytesAvailableToUser,
          quotaFree: s.unusedBytesAvailableToUser,
          source: 'space-available',
        };
      } catch (e) {
        if (!ext.isOperationUnsupported(e)) throw e;
        this._log('debug', `space-available refused: ${e.message}`);
      }
    }

    if (!this.serverCaps.statVfsV2 && !force) return null;
    const st = await this.ext.statvfs(target, { force });
    for (const line of [
      `Block size: ${st.blockSize}`,
      `Fundamental block size: ${st.fundamentalBlockSize}`,
      `Total blocks: ${st.blocks}`,
      `Free blocks: ${st.freeBlocks}`,
      `Free blocks for non-root: ${st.availableBlocks}`,
      `Total file inodes: ${st.fileInodes}`,
      `Free file inodes: ${st.freeFileInodes}`,
      `Free file inodes for non-root: ${st.availableFileInodes}`,
      `Flags: ${st.flagNames.join(',')}`,
      `Max name length: ${st.nameMax}`,
    ]) this._log('debug', line);

    return {
      path: target,
      total: st.total,
      free: st.unusedAvailableToUser,
      used: st.total - st.unused,
      blockSize: st.bytesPerAllocationUnit,
      files: st.fileInodes,
      filesFree: st.freeFileInodes,
      readOnly: st.readOnly,
      nameMax: st.nameMax,
      source: 'statvfs@openssh.com',
    };
  }

  /**
   * The owner and group names the server will accept, when it offers the
   * generic-extensions query. Without it the properties dialog can only take a
   * numeric id, which is what SFTP 3 carries anyway.
   */
  async listUsersGroups() {
    if (!this.ext || !this.serverAbilities || !this.serverAbilities.userGroupListing) return null;
    const [owners, groups] = await Promise.all([
      this.ext.ownerGroupQuery('owners').catch(() => null),
      this.ext.ownerGroupQuery('groups').catch(() => null),
    ]);
    if (!owners && !groups) return null;
    return { owners: owners || [], groups: groups || [] };
  }
}

module.exports = {
  SftpAdapter,
  SshTransport,
  extensions: ext,
  fingerprints,
  algorithmList,
  parseDataSize,
  rightsFromMode,
  parseRights,
  shellQuote,
  normalizeTimes,
  openSocket,
  agentPath,
  signedSeconds,
  applySshSendBuffer,
  CIPHERS,
  KEXES,
  HOSTKEYS,
};
