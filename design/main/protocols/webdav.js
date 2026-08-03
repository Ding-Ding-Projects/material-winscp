// webdav.js — WebDAV and WebDAVS, written directly against the wire format.
//
// No HTTP or XML dependency is added here, deliberately:
//
//   * The protocol is small enough to write out (PROPFIND, MKCOL, MOVE, COPY
//     and friends), and writing it means the multistatus parser is a plain
//     function this repository owns and can test against real server output
//     instead of a black box.
//   * `fetch()` cannot carry a client certificate or a per-session TLS policy
//     without an undici Agent, which is not a public Node module. `node:https`
//     gives us the client certificate, the TLS version floor, streaming
//     request bodies and the peer certificate for the verification prompt —
//     all of which WinSCP exposes and all of which fetch() hides.
//
// Every WebDAV server disagrees about namespace prefixes (`D:`, `d:`, `a:`,
// `lp1:`, or a default `xmlns="DAV:"`), so the parser resolves prefixes to
// namespace URIs properly rather than string-matching on `D:href`.
'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');
const { PassThrough, Writable } = require('stream');
const { Adapter, entry } = require('./base');

const DAV_NS = 'DAV:';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

// ---------------------------------------------------------------------------
// A small, namespace-aware XML reader
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

/** Find the `>` that closes a tag, ignoring any inside an attribute value. */
function findTagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

const ATTR_RE = /([^\s=/<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Parse an XML document into a tree of
 * `{ ns, local, attrs, children, text }`.
 *
 * This is not a general XML processor — no DTD, no entity declarations, no
 * validation — but it does the one thing a WebDAV client actually needs
 * correctly: resolve element namespaces through prefix declarations so that
 * `D:href`, `d:href`, `a:href` and a defaulted `href` are all the same element.
 */
function parseXml(text) {
  const root = { ns: '', local: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const nsStack = [{ '': '', xml: XML_NS }];
  const src = String(text);
  let i = 0;

  const addText = (s) => {
    if (!s) return;
    stack[stack.length - 1].text += s;
  };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(decodeEntities(src.slice(i))); break; }
    if (lt > i) addText(decodeEntities(src.slice(i, lt)));

    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      addText(src.slice(lt + 9, e < 0 ? src.length : e));   // CDATA is literal
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt);
      i = e < 0 ? src.length : e + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {          // DOCTYPE and friends
      const e = findTagEnd(src, lt);
      i = e < 0 ? src.length : e + 1;
      continue;
    }

    const gt = findTagEnd(src, lt);
    if (gt < 0) break;
    let raw = src.slice(lt + 1, gt);
    i = gt + 1;

    if (raw[0] === '/') {                    // closing tag
      if (stack.length > 1) { stack.pop(); nsStack.pop(); }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    if (selfClosing) raw = raw.slice(0, -1);

    const nameMatch = /^([^\s/>]+)/.exec(raw);
    if (!nameMatch) continue;
    const qname = nameMatch[1];
    const attrText = raw.slice(qname.length);

    const attrs = {};
    const declared = { ...nsStack[nsStack.length - 1] };
    ATTR_RE.lastIndex = 0;
    let a;
    while ((a = ATTR_RE.exec(attrText)) !== null) {
      const key = a[1];
      const value = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
      if (key === 'xmlns') declared[''] = value;
      else if (key.startsWith('xmlns:')) declared[key.slice(6)] = value;
      else attrs[key] = value;
    }

    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? '' : qname.slice(0, colon);
    const local = colon < 0 ? qname : qname.slice(colon + 1);
    const node = {
      ns: declared[prefix] !== undefined ? declared[prefix] : '',
      local,
      attrs,
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) { stack.push(node); nsStack.push(declared); }
  }

  return root;
}

/** All descendants (depth-first) matching a namespace + local name. */
function findAll(node, ns, local, out = []) {
  for (const child of node.children) {
    if (child.ns === ns && child.local === local) out.push(child);
    findAll(child, ns, local, out);
  }
  return out;
}

/** Direct children matching a namespace + local name. */
function childrenNamed(node, ns, local) {
  return node.children.filter((c) => c.ns === ns && c.local === local);
}

function firstNamed(node, ns, local) {
  return node.children.find((c) => c.ns === ns && c.local === local) || null;
}

function statusCodeOf(text) {
  const m = /HTTP\/[\d.]+\s+(\d{3})/i.exec(String(text || ''));
  return m ? Number(m[1]) : 0;
}

/**
 * Parse a `207 Multi-Status` body into one record per `<response>`.
 *
 * Returns objects shaped as
 *   `{ href, path, name, type, size, mtime, ctime, etag, contentType,
 *      status, props, quota }`
 * where `path` is the decoded, slash-normalized path from the href — servers
 * are free to answer with a full absolute URL, a rooted path, or (against the
 * spec, but Microsoft did it anyway) a relative one.
 *
 * Exported so it can be tested against captured server output.
 */
function parseMultistatus(xml, opts = {}) {
  const doc = parseXml(xml);
  const responses = findAll(doc, DAV_NS, 'response');
  const base = opts.baseUrl || 'http://localhost/';
  const out = [];

  for (const res of responses) {
    const hrefNode = firstNamed(res, DAV_NS, 'href');
    if (!hrefNode) continue;
    const href = hrefNode.text.trim();

    let path;
    try {
      path = decodeURIComponent(new URL(href, base).pathname);
    } catch {
      // A malformed href is still worth reporting rather than dropping.
      path = href;
    }

    const props = {};
    let ok = 0;
    for (const propstat of childrenNamed(res, DAV_NS, 'propstat')) {
      const statusNode = firstNamed(propstat, DAV_NS, 'status');
      const code = statusCodeOf(statusNode ? statusNode.text : '');
      // Only 2xx propstats carry values; a 404 propstat lists the properties
      // the server does not have, which is useful to nobody here.
      if (code && (code < 200 || code >= 300)) continue;
      ok = code || 200;
      const propNode = firstNamed(propstat, DAV_NS, 'prop');
      if (!propNode) continue;
      for (const p of propNode.children) {
        props[p.ns === DAV_NS ? p.local : `${p.ns}#${p.local}`] = p;
      }
    }

    const responseStatus = firstNamed(res, DAV_NS, 'status');
    const status = responseStatus ? statusCodeOf(responseStatus.text) : ok;

    const resourcetype = props.resourcetype;
    const isCollection = !!(resourcetype && firstNamed(resourcetype, DAV_NS, 'collection'))
      // Some servers only signal a collection by ending the href in a slash.
      || (!resourcetype && href.endsWith('/') && href !== '/');

    const textOf = (name) => (props[name] ? props[name].text.trim() : '');
    const lastMod = textOf('getlastmodified');
    const created = textOf('creationdate');
    const lengthText = textOf('getcontentlength');

    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
    const segs = trimmed.split('/').filter(Boolean);
    const displayName = textOf('displayname');

    out.push({
      href,
      path: trimmed || '/',
      // displayname is advisory and is empty or wrong on plenty of servers, so
      // the href is the authority for the name.
      name: segs.length ? segs[segs.length - 1] : (displayName || '/'),
      displayName,
      type: isCollection ? 'dir' : 'file',
      isCollection,
      size: lengthText === '' ? 0 : Number(lengthText) || 0,
      mtime: lastMod ? (Date.parse(lastMod) || 0) : 0,
      ctime: created ? (Date.parse(created) || 0) : 0,
      etag: textOf('getetag').replace(/^W\//, '').replace(/^"|"$/g, ''),
      contentType: textOf('getcontenttype'),
      status,
      quota: {
        available: textOf('quota-available-bytes') ? Number(textOf('quota-available-bytes')) : null,
        used: textOf('quota-used-bytes') ? Number(textOf('quota-used-bytes')) : null,
      },
      props,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Path escaping
// ---------------------------------------------------------------------------

function pctEncode(str) {
  return Array.from(Buffer.from(str, 'utf8'))
    .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
}

/**
 * Percent-encode one path segment.
 *
 * WinSCP's "liberal escaping of unsafe characters" escapes everything outside
 * the RFC 3986 unreserved set. With it off we leave the sub-delimiters alone,
 * which is what most servers expect and what keeps `+`, `,` and `@` readable
 * in a URL. Some servers (notably older IIS and a few appliance stacks) choke
 * on those characters unescaped, which is why the option exists.
 */
function encodeSegment(seg, liberal) {
  if (liberal) {
    return seg.replace(/[^A-Za-z0-9\-_.~]/g, (c) => pctEncode(c));
  }
  return seg.replace(/[^A-Za-z0-9\-_.~!$&'()*+,;=:@]/g, (c) => pctEncode(c));
}

function encodePath(p, liberal) {
  return String(p).split('/').map((s) => encodeSegment(s, liberal)).join('/');
}

// ---------------------------------------------------------------------------
// Digest authentication (RFC 7616)
// ---------------------------------------------------------------------------

/** Split on commas that are not inside a quoted string. */
function splitOutsideQuotes(text) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\' && i + 1 < text.length) { cur += c + text[i + 1]; i += 1; continue; }
      if (c === '"') quoted = false;
      cur += c;
      continue;
    }
    if (c === '"') { quoted = true; cur += c; continue; }
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function addAuthParam(challenge, text) {
  const m = /^([A-Za-z0-9._-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(.*))$/.exec(text.trim());
  if (!m) {
    // A scheme like Negotiate carries a single base64 blob instead of params.
    challenge.params.token68 = text.trim();
    return;
  }
  challenge.params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3].trim();
}

/**
 * Split a `WWW-Authenticate` header into its challenges.
 *
 * The grammar is genuinely awkward: challenges are comma-separated, their
 * parameters are *also* comma-separated, and a quoted parameter may contain
 * commas of its own (`qop="auth,auth-int"`, `realm="a, b"`). What
 * distinguishes a new challenge from another parameter is a space before the
 * first `=`, which is what the walk below keys on.
 */
function parseAuthenticate(header) {
  const out = [];
  for (const item of splitOutsideQuotes(String(header || ''))) {
    const t = item.trim();
    if (!t) continue;
    const scheme = /^([A-Za-z][A-Za-z0-9._-]*)/.exec(t);
    const eq = t.indexOf('=');
    const space = t.search(/\s/);
    const startsChallenge = scheme && ((space >= 0 && (eq < 0 || space < eq)) || (space < 0 && eq < 0));
    if (startsChallenge) {
      const challenge = { scheme: scheme[1], params: {} };
      out.push(challenge);
      const rest = t.slice(scheme[1].length).trim();
      if (rest) addAuthParam(challenge, rest);
      continue;
    }
    if (out.length) addAuthParam(out[out.length - 1], t);
  }
  return out;
}

function digestHash(algorithm, data) {
  const alg = /sha-?512-256/i.test(algorithm) ? 'sha512-256'
    : (/sha-?256/i.test(algorithm) ? 'sha256' : 'md5');
  // SHA-512/256 is a distinct SHA-2 function with different IVs, not the
  // first 256 bits of SHA-512. OpenSSL (and Node's crypto wrapper) exposes the
  // standardized digest directly, which is what RFC 7616's algorithm name
  // requires.
  return crypto.createHash(alg).update(data, 'utf8').digest('hex');
}

/**
 * Build a `Digest` Authorization header value.
 *
 * Exported for the sake of anyone debugging a server that rejects our
 * credentials — the value is entirely derived from the challenge, so being
 * able to reproduce it outside a connection is the difference between a
 * five-minute fix and an afternoon with a packet capture.
 */
function buildDigestHeader({ username, password, method, uri, challenge, nc, cnonce, body }) {
  const p = challenge.params;
  const algorithm = p.algorithm || 'MD5';
  const sess = /-sess$/i.test(algorithm);
  const H = (s) => digestHash(algorithm, s);

  let ha1 = H(`${username}:${p.realm || ''}:${password}`);
  if (sess) ha1 = H(`${ha1}:${p.nonce}:${cnonce}`);

  const qopList = String(p.qop || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const qop = qopList.includes('auth') ? 'auth' : (qopList.includes('auth-int') ? 'auth-int' : '');

  const ha2 = qop === 'auth-int'
    ? H(`${method}:${uri}:${H(body ? body.toString('utf8') : '')}`)
    : H(`${method}:${uri}`);

  const ncHex = String(nc).padStart(8, '0');
  const response = qop
    ? H(`${ha1}:${p.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : H(`${ha1}:${p.nonce}:${ha2}`);

  const parts = [
    `username="${username.replace(/"/g, '\\"')}"`,
    `realm="${p.realm || ''}"`,
    `nonce="${p.nonce || ''}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (p.algorithm) parts.push(`algorithm=${p.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  if (p.opaque) parts.push(`opaque="${p.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Upload stream
// ---------------------------------------------------------------------------

/**
 * How much of a body we are willing to hold in memory in order to be able to
 * announce a Content-Length we have actually counted.
 *
 * The caller's `size` is a hint about the *source* file, not a promise about
 * the bytes that will be written: the transfer queue passes the source size
 * even in text mode, where CRLF folding changes the byte count on the way
 * through. Announcing that number and then sending fewer bytes leaves the
 * server waiting for a body that never finishes arriving — the upload hangs
 * until the socket times out, which is exactly what a real server proved.
 *
 * So anything that fits in this buffer is sent with a Content-Length that was
 * measured rather than predicted. Bigger bodies keep the streaming path (a
 * multi-gigabyte upload cannot be buffered) and their announced length is
 * enforced rather than assumed, so a mismatch fails loudly instead of hanging.
 */
const INLINE_PUT_LIMIT = 8 * 1024 * 1024;

/**
 * A write stream whose `finish` waits for the server's response, so a queue
 * item is not marked complete before the PUT is acknowledged. A 507
 * (insufficient storage) arrives *after* the last byte; without this it would
 * have nowhere to be reported.
 *
 * The request is opened lazily — see INLINE_PUT_LIMIT above.
 */
class PutStream extends Writable {
  constructor(adapter, path, opts) {
    super();
    this.adapter = adapter;
    this.path = path;
    this.opts = opts;
    this.declaredSize = opts.size === undefined || opts.size === null ? null : Number(opts.size);
    this.chunks = [];
    this.buffered = 0;
    this.req = null;
    this.done = null;
    this.contentLength = null;   // what we actually announced, once we have
    this.sent = 0;
    this.failure = null;
  }

  async _open(contentLength) {
    const opts = this.opts;
    const headers = { 'Content-Type': opts.contentType || 'application/octet-stream' };
    if (contentLength === null) headers['Transfer-Encoding'] = 'chunked';
    else headers['Content-Length'] = String(contentLength);
    if (opts.etag) headers['If-Match'] = `"${opts.etag}"`;
    if (opts.onlyIfNew) headers['If-None-Match'] = '*';

    const { req } = await this.adapter._send('PUT', this.path, { headers, stream: true });
    this.req = req;
    this.contentLength = contentLength;
    this.done = new Promise((resolve, reject) => {
      req.on('response', async (res) => {
        const text = (await WebDavAdapter.readBody(res)).toString('utf8');
        if (res.statusCode >= 400) {
          const err = new Error(`PUT ${this.path} failed: ${res.statusCode} ${res.statusMessage}${this.adapter._explain(text)}`);
          err.status = res.statusCode;
          reject(err);
        } else {
          resolve({ status: res.statusCode, etag: res.headers.etag });
        }
      });
      req.on('error', reject);
    });
    // `done` is normally awaited by `_final`, but a socket that dies part way
    // through the body never reaches `_final`: the error listener below
    // destroys the stream instead. That would leave `done` rejected with
    // nobody waiting on it, and Node treats an unhandled rejection as fatal —
    // so an interrupted upload would take the whole main process down with it.
    // Marking it handled here costs nothing: `.catch()` returns a *new*
    // promise, so the `await this.done` in `_final` still sees the rejection.
    this.done.catch(() => {});
    // Surface a socket failure on the Writable too, so a stalled `_write`
    // is released instead of waiting for a drain that will never come.
    req.on('error', (e) => { this.failure = e; this.destroy(e); });
  }

  _toWire(chunk) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.contentLength !== null && this.sent + chunk.length > this.contentLength) {
      return Promise.reject(new Error(
        `PUT ${this.path}: the body is longer than the ${this.contentLength} bytes announced to the server`));
    }
    this.sent += chunk.length;
    return new Promise((resolve) => {
      if (this.req.write(chunk)) resolve();
      else this.req.once('drain', resolve);
    });
  }

  async _consume(chunk) {
    if (this.req) { await this._toWire(chunk); return; }
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered <= INLINE_PUT_LIMIT) return;
    // Too big to hold. Fall back to streaming: keep the caller's size when it
    // is at least what we have already seen, otherwise let the server read to
    // the end of a chunked body rather than to a number we cannot honour.
    await this._open(this.declaredSize !== null && this.declaredSize >= this.buffered
      ? this.declaredSize : null);
    const pending = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    await this._toWire(pending);
  }

  _write(chunk, enc, cb) {
    this._consume(chunk).then(() => cb(), cb);
  }

  _final(cb) {
    const finish = async () => {
      if (!this.req) {
        // The whole body is in hand, so the length we announce is measured.
        const body = Buffer.concat(this.chunks, this.buffered);
        this.chunks = [];
        await this._open(body.length);
        if (body.length) await this._toWire(body);
      } else if (this.contentLength !== null && this.sent !== this.contentLength) {
        this.req.destroy();
        throw new Error(`PUT ${this.path}: announced ${this.contentLength} bytes but produced ${this.sent}; `
          + 'the server would wait forever for the rest');
      }
      this.req.end();
      await this.done;
    };
    finish().then(() => cb(), (e) => cb(e));
  }

  _destroy(err, cb) {
    if (err && this.req) this.req.destroy(err);
    cb(err);
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const TLS_VERSIONS = {
  tls10: 'TLSv1', tls11: 'TLSv1.1', tls12: 'TLSv1.2', tls13: 'TLSv1.3',
};

class WebDavAdapter extends Adapter {
  /**
   * @param session  a site record shaped like SESSION_DEFAULTS
   * @param options  host services injected by session.js:
   *                 `certVerifier(host, cert, problem)` → boolean|Promise
   *                 `password`  resolved secret (never read from disk here)
   *                 `allowCrossHostRedirect`  follow a redirect off this host
   *                 `log(level, message)`
   */
  constructor(session, options = {}) {
    super(session);
    this.options = options;
    this.secure = session.ftps && session.ftps !== 'none';
    this.host = session.hostName;
    this.port = Number(session.portNumber) || (this.secure ? 443 : 80);
    this.base = `${this.secure ? 'https' : 'http'}://${this.host}:${this.port}`;
    this.davClasses = [];
    this.allowed = [];
    this._challenge = null;      // the Digest challenge we are answering
    this._nc = 0;
    this._pinned = null;         // fingerprint256 the user accepted
    this._agent = null;
    // Whether the server serves byte ranges on GET. This is NOT the same thing
    // as `caps.resume` — see the comment on that flag below.
    this.rangeReads = false;
    this.caps = {
      ...this.caps,
      rights: false,        // WebDAV has no portable permission model
      owner: false,
      symlink: false,
      exec: false,
      // WinSCP answers false to fcResumeSupport for WebDAV
      // (core/WebDAVFileSystem.cpp), and so must we. `caps.resume` is read by
      // the transfer queue for BOTH sides of a copy: it means "this backend can
      // continue a transfer at an offset". A server advertising Accept-Ranges
      // proves only that it can *serve* a range; a PUT still replaces the whole
      // resource, so claiming resume support makes the queue write a file's
      // tail into a `.filepart` and rename it over the target, or split the
      // upload across parallel connections that each overwrite the last.
      // Ranged reads stay available through `rangeReads`.
      resume: false,
      timestamp: false,     // getlastmodified is a live property, not settable
      checksum: false,
      copyRemote: true,     // COPY
      nativeMove: true,     // MOVE
      rename: true,
      move: true,
      hiddenFiles: true,
      spaceInfo: false,     // set when RFC 4331 quota properties come back
    };
  }

  get protocolName() { return this.secure ? 'WebDAVS' : 'WebDAV'; }

  _log(level, message) {
    if (this.options.log) this.options.log(level, message);
    this.emit('log', { level, message });
  }

  // -- TLS -----------------------------------------------------------------

  _tlsBase() {
    const s = this.session;
    const opts = {
      minVersion: TLS_VERSIONS[s.minTlsVersion] || 'TLSv1',
      maxVersion: TLS_VERSIONS[s.maxTlsVersion] || 'TLSv1.3',
      servername: this.host,
    };
    if (s.tlsCertificateFile) {
      // One PEM holding the client certificate, its key, and often the CA that
      // issued the server certificate — the same file WinSCP asks for.
      const pem = fs.readFileSync(s.tlsCertificateFile);
      opts.cert = pem;
      opts.key = pem;
      opts.ca = pem;
    }
    return opts;
  }

  /**
   * Look at the server certificate once, before any credential is sent, and
   * let the application decide. If it is accepted despite a chain problem we
   * pin its fingerprint: subsequent requests then verify against that exact
   * certificate instead of running with verification switched off.
   */
  async _verifyCertificate() {
    if (!this.secure) return;
    const opts = { ...this._tlsBase(), host: this.host, port: this.port, rejectUnauthorized: false };
    const socket = await new Promise((res, rej) => {
      const s = tls.connect(opts, () => res(s));
      s.once('error', rej);
      s.setTimeout(Math.max(1, Number(this.session.timeout || 15)) * 1000, () => {
        s.destroy(new Error(`Timed out connecting to ${this.host}:${this.port}`));
      });
    });
    const cert = socket.getPeerCertificate(true);
    const authorized = socket.authorized === true;
    const problem = authorized ? null : String(socket.authorizationError || 'certificate not trusted');
    socket.destroy();

    const summary = {
      subject: cert.subject, issuer: cert.issuer,
      valid_from: cert.valid_from, valid_to: cert.valid_to,
      fingerprint: cert.fingerprint, fingerprint256: cert.fingerprint256,
      serialNumber: cert.serialNumber, subjectaltname: cert.subjectaltname,
      authorized, problem,
    };
    this.serverInfo.certificate = summary;

    let accepted = authorized;
    if (this.options.certVerifier) {
      accepted = await this.options.certVerifier(this.host, summary, problem);
    }
    if (!accepted) {
      throw new Error(`TLS certificate rejected for ${this.host}: ${problem || 'not accepted'}`);
    }
    // Only drop to pinning when the standard chain check failed; a normally
    // trusted server keeps full verification on every request.
    if (!authorized) this._pinned = cert.fingerprint256;
  }

  _makeAgent() {
    const keepAlive = { keepAlive: true, maxSockets: 8 };
    if (!this.secure) { this._agent = new http.Agent(keepAlive); return; }
    this._agent = new https.Agent({
      ...keepAlive,
      ...this._tlsBase(),
      // With a user-accepted certificate we verify by fingerprint in
      // `_pinCheck()`; otherwise Node's own chain validation stays on.
      rejectUnauthorized: !this._pinned,
    });
  }

  _pinCheck(req) {
    if (!this._pinned) return;
    req.on('socket', (socket) => {
      const check = () => {
        const cert = socket.getPeerCertificate ? socket.getPeerCertificate() : null;
        if (!cert || cert.fingerprint256 !== this._pinned) {
          socket.destroy(new Error('Server certificate changed since it was accepted'));
        }
      };
      if (socket.getPeerCertificate && socket.getPeerCertificate().fingerprint256) check();
      else socket.once('secureConnect', check);
    });
  }

  // -- HTTP ----------------------------------------------------------------

  _url(p) {
    return `${this.base}${encodePath(this.normalize(p), this.session.webDavLiberalEscaping)}`;
  }

  /**
   * Compare a redirect target with the configured session origin.
   *
   * URL.host is not enough here: `dav.example:443` and
   * `dav.example:8443` have the same hostname but are different origins, and
   * an omitted default port is normalized away by WHATWG URL. Keeping this
   * check in one place prevents both credential leakage and accidental reuse
   * of the session's keep-alive agent on a different origin.
   */
  _sameOrigin(url) {
    const base = new URL(this.base);
    const effectivePort = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');
    return url.protocol === base.protocol
      && url.hostname.toLowerCase() === base.hostname.toLowerCase()
      && effectivePort(url) === effectivePort(base);
  }

  _authHeader(method, uri, body) {
    const s = this.session;
    const user = s.anonymous ? '' : (s.userName || '');
    const pass = this.options.password !== undefined ? this.options.password : (s.password || '');
    if (!user && !pass) return null;

    if (this._challenge && /^digest$/i.test(this._challenge.scheme)) {
      this._nc += 1;
      return buildDigestHeader({
        username: user,
        password: pass,
        method,
        uri,
        challenge: this._challenge,
        nc: this._nc,
        cnonce: crypto.randomBytes(8).toString('hex'),
        body,
      });
    }
    return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
  }

  /**
   * One HTTP round trip.
   *
   * @param method  HTTP/WebDAV method
   * @param target  a path on this server, or an absolute URL for a redirect
   * @param opts    { headers, body, stream, depth, redirects }
   * @returns       { status, headers, res } — `res` is the live response
   *                stream unless `opts.text` asked for the body to be read.
   */
  _send(method, target, opts = {}) {
    const url = new URL(target.startsWith('http') ? target : this._url(target));
    const isTls = url.protocol === 'https:';
    const lib = isTls ? https : http;
    const body = opts.body === undefined ? null : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf8'));

    const headers = {
      Host: url.port && url.port !== (isTls ? '443' : '80') ? `${url.hostname}:${url.port}` : url.hostname,
      'User-Agent': 'WinSCP-Material/1.0',
      Accept: '*/*',
      ...(opts.headers || {}),
    };
    if (body) headers['Content-Length'] = String(body.length);

    const uri = url.pathname + (url.search || '');
    // Credentials go out preemptively. A PUT streamed from disk cannot be
    // replayed after a 401, so waiting for a challenge on every request would
    // make uploads unresumable; the first request of the session discovers the
    // scheme and every later one uses it.
    // A redirect target is allowed to be absolute. Never send the session's
    // credentials to another origin, even when the user explicitly allowed
    // following cross-host redirects. The redirect policy below decides
    // whether to follow; this check decides what may cross the boundary.
    const sameOrigin = this._sameOrigin(url);
    const auth = sameOrigin ? this._authHeader(method, uri, body) : null;
    if (auth) headers.Authorization = auth;

    return new Promise((resolve, reject) => {
      const req = lib.request({
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isTls ? 443 : 80),
        path: uri,
        headers,
        agent: sameOrigin ? this._agent : undefined,
        timeout: Math.max(1, Number(this.session.timeout || 15)) * 1000,
        // A redirect can land on a different host, which the session agent
        // must not serve; it gets the session's TLS policy but its own name.
        ...(isTls && url.hostname !== this.host ? { ...this._tlsBase(), servername: url.hostname } : {}),
      }, (res) => resolve({ req, res }));

      this._pinCheck(req);
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`Timed out waiting for ${method} ${uri}`)));

      if (opts.stream) {
        // The caller writes the body itself (a streamed upload).
        resolve({ req, res: null, streaming: true });
        return;
      }
      if (body) req.write(body);
      req.end();
    });
  }

  static readBody(res) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  }

  /**
   * A request with the whole lifecycle applied: 401 challenge handling,
   * redirects, and turning a failing status into an Error with the server's
   * own explanation in it.
   */
  async request(method, target, opts = {}) {
    let attempt = 0;
    let redirects = 0;
    let current = target;

    for (;;) {
      const { res } = await this._send(method, current, opts);

      if (res.statusCode === 401 && attempt === 0 && !opts.noRetry) {
        attempt += 1;
        const challenges = parseAuthenticate(res.headers['www-authenticate']);
        await WebDavAdapter.readBody(res);
        const chosen = this._chooseChallenge(challenges);
        if (!chosen) throw new Error('Authentication failed: server offered no scheme we support');
        this._challenge = chosen;
        this._nc = 0;
        continue;
      }

      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        const currentUrl = new URL(current.startsWith('http') ? current : this._url(current));
        const next = new URL(res.headers.location, currentUrl);
        if (currentUrl.protocol === 'https:' && next.protocol !== 'https:') {
          await WebDavAdapter.readBody(res);
          throw new Error('Refusing redirect from HTTPS to HTTP');
        }
        if (!this._sameOrigin(next) && !this.options.allowCrossHostRedirect) {
          await WebDavAdapter.readBody(res);
          throw new Error(`Refusing redirect to another host (${next.host}); enable cross-host redirects for this site to allow it`);
        }
        if (opts.stream) {
          await WebDavAdapter.readBody(res);
          throw new Error('Server redirected a streamed upload; the body cannot be replayed');
        }
        await WebDavAdapter.readBody(res);
        redirects += 1;
        current = next.toString();
        continue;
      }

      if (opts.raw) return res;

      const buf = await WebDavAdapter.readBody(res);
      const text = buf.toString('utf8');
      if (res.statusCode >= 400) {
        const err = new Error(`${method} ${new URL(current.startsWith('http') ? current : this._url(current)).pathname} failed: ${res.statusCode} ${res.statusMessage}${this._explain(text)}`);
        err.status = res.statusCode;
        throw err;
      }
      return { status: res.statusCode, headers: res.headers, body: buf, text };
    }
  }

  _chooseChallenge(challenges) {
    if (!challenges.length) return null;
    const digests = challenges.filter((c) => /^digest$/i.test(c.scheme));
    const basic = challenges.find((c) => /^basic$/i.test(c.scheme));
    // `webDavAuthLegacy` is WinSCP's escape hatch for servers whose Digest
    // implementation is broken: it forces plain Basic even when Digest is on
    // offer. Basic over plain HTTP puts the password on the wire, so say so.
    if (this.session.webDavAuthLegacy) {
      if (basic && !this.secure) this._log('warning', 'Legacy authentication over plain HTTP sends the password unencrypted');
      return basic || digests[0] || challenges[0];
    }
    if (digests.length) {
      // Prefer the strongest digest the server offers.
      const byStrength = (c) => (/sha-?512/i.test(c.params.algorithm || '') ? 3
        : (/sha-?256/i.test(c.params.algorithm || '') ? 2 : 1));
      return digests.sort((a, b) => byStrength(b) - byStrength(a))[0];
    }
    if (basic && !this.secure) this._log('warning', 'Server offers only Basic authentication over plain HTTP');
    return basic || null;
  }

  /** Pull the human-readable bit out of a DAV error body, if there is one. */
  _explain(text) {
    if (!text) return '';
    const trimmed = text.trim();
    if (!trimmed.startsWith('<')) return ` — ${trimmed.slice(0, 200)}`;
    const doc = parseXml(trimmed);
    for (const name of ['message', 'exception', 'responsedescription']) {
      const found = findAll(doc, DAV_NS, name)[0]
        || findAll(doc, 'http://sabredav.org/ns', name)[0];
      if (found && found.text.trim()) return ` — ${found.text.trim().slice(0, 200)}`;
    }
    return '';
  }

  // -- lifecycle -----------------------------------------------------------

  async connect() {
    await this._verifyCertificate();
    this._makeAgent();

    const root = this.session.remoteDirectory && this.session.remoteDirectory !== ''
      ? this.normalize(this.session.remoteDirectory)
      : '/';

    // OPTIONS tells us which compliance classes and methods exist. Servers
    // that do not answer it are still usable, so a failure here is logged,
    // not fatal.
    try {
      const res = await this.request('OPTIONS', root);
      this.davClasses = String(res.headers.dav || '').split(',').map((s) => s.trim()).filter(Boolean);
      this.allowed = String(res.headers.allow || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      this.serverInfo.dav = this.davClasses;
      this.serverInfo.allow = this.allowed;
      this.serverInfo.server = res.headers.server || '';
      if (this.allowed.length) {
        this.caps.copyRemote = this.allowed.includes('COPY');
        this.caps.nativeMove = this.allowed.includes('MOVE');
        this.caps.rename = this.caps.nativeMove;
        this.caps.move = this.caps.nativeMove;
      }
      if (!this.davClasses.length) {
        this._log('warning', 'Server did not advertise a DAV compliance class; it may not be a WebDAV server');
      }
    } catch (e) {
      this._log('warning', `OPTIONS ${root} failed: ${e.message}`);
    }

    // Byte ranges are what makes a partial read possible. Ask rather than
    // assume: a server that ignores Range answers 200 with the whole file, and
    // appending that to a partial download would corrupt it.
    try {
      const head = await this.request('HEAD', root, { noRetry: false });
      this.rangeReads = /bytes/i.test(String(head.headers['accept-ranges'] || ''));
    } catch {
      this.rangeReads = false;
    }
    this.serverInfo.acceptRanges = this.rangeReads;

    // A PROPFIND on the root proves the credentials and finds the quota.
    const items = await this._propfind(root, 0);
    const self = items[0];
    if (self && self.quota && (self.quota.available !== null || self.quota.used !== null)) {
      this.caps.spaceInfo = true;
    }

    this.home = root;
    this.connected = true;
    return { home: this.home, dav: this.davClasses };
  }

  async disconnect() {
    this.connected = false;
    if (this._agent && this._agent.destroy) this._agent.destroy();
    this._agent = null;
    this._challenge = null;
  }

  // -- reading -------------------------------------------------------------

  async _propfind(p, depth, propsXml) {
    const body = propsXml || `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop>
<D:displayname/><D:getcontentlength/><D:getlastmodified/><D:creationdate/>
<D:resourcetype/><D:getetag/><D:getcontenttype/>
<D:quota-available-bytes/><D:quota-used-bytes/>
</D:prop></D:propfind>`;

    const res = await this.request('PROPFIND', p, {
      headers: {
        Depth: String(depth),
        'Content-Type': 'application/xml; charset="utf-8"',
      },
      body,
    });
    if (res.status !== 207 && res.status !== 200) {
      throw new Error(`PROPFIND ${p} returned ${res.status}, expected 207 Multi-Status`);
    }
    return parseMultistatus(res.text, { baseUrl: this._url(p) });
  }

  async list(dir) {
    const path = this.normalize(dir || this.home);
    const items = await this._propfind(path, 1);
    const selfPath = path === '/' ? '/' : path.replace(/\/+$/, '');
    return items
      // Depth 1 includes the collection itself; the panel adds `..` on its own.
      .filter((i) => i.path !== selfPath && i.status < 300)
      .map((i) => entry({
        name: i.name,
        type: i.type,
        size: i.size,
        mtime: i.mtime,
        raw: { href: i.href, etag: i.etag, contentType: i.contentType, displayName: i.displayName },
      }));
  }

  async stat(p) {
    const path = this.normalize(p);
    const items = await this._propfind(path, 0);
    if (!items.length) throw new Error(`No such resource: ${path}`);
    const i = items[0];
    return entry({
      name: this.basename(path) || '/',
      type: i.type,
      size: i.size,
      mtime: i.mtime,
      raw: { href: i.href, etag: i.etag, contentType: i.contentType },
    });
  }

  async spaceInfo(p) {
    const items = await this._propfind(this.normalize(p || this.home), 0);
    const q = items.length ? items[0].quota : null;
    if (!q || (q.available === null && q.used === null)) return null;
    return {
      // RFC 4331 reports what is left and what is used; the total is derived.
      bytesAvailable: q.available,
      bytesUsed: q.used,
      bytesTotal: q.available !== null && q.used !== null ? q.available + q.used : null,
    };
  }

  // -- writing -------------------------------------------------------------

  async mkdir(p, opts = {}) {
    const path = this.normalize(p);
    if (!opts.recursive) { await this.request('MKCOL', path); return; }
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      try {
        await this.request('MKCOL', cur);
      } catch (e) {
        // 405 is "already a collection here", which is success for a
        // recursive mkdir. Anything else is a real failure.
        if (e.status !== 405) throw e;
      }
    }
  }

  async remove(p) {
    const path = this.normalize(p);
    // DELETE on a collection is defined to be recursive, so there is no walk
    // here — but the server may answer 207 listing the members it could not
    // remove, and that must not be reported as success.
    const res = await this.request('DELETE', path, { headers: { Depth: 'infinity' } });
    if (res.status === 207) {
      const failed = parseMultistatus(res.text, { baseUrl: this._url(path) })
        .filter((i) => i.status >= 400);
      if (failed.length) {
        throw new Error(`Could not delete ${failed.length} item(s), first: ${failed[0].path} (${failed[0].status})`);
      }
    }
  }

  async rename(from, to, opts = {}) {
    return this._moveOrCopy('MOVE', from, to, opts);
  }

  /** Server-side duplicate — the whole point of `caps.copyRemote`. */
  async copy(from, to, opts = {}) {
    return this._moveOrCopy('COPY', from, to, opts);
  }

  async _moveOrCopy(method, from, to, opts) {
    const src = this.normalize(from);
    const dst = this.normalize(to);
    const res = await this.request(method, src, {
      headers: {
        Destination: this._url(dst),
        Overwrite: opts.overwrite === false ? 'F' : 'T',
        Depth: 'infinity',
      },
    });
    if (res.status === 207) {
      const failed = parseMultistatus(res.text, { baseUrl: this._url(src) })
        .filter((i) => i.status >= 400);
      if (failed.length) {
        throw new Error(`${method} partially failed, first: ${failed[0].path} (${failed[0].status})`);
      }
    }
  }

  // -- streaming -----------------------------------------------------------

  async createReadStream(p, opts = {}) {
    const path = this.normalize(p);
    const start = Number(opts.start || 0);
    const headers = {};
    if (start > 0) {
      if (!this.rangeReads) throw new Error('Server does not advertise byte ranges; cannot resume');
      headers.Range = opts.end ? `bytes=${start}-${opts.end}` : `bytes=${start}-`;
    }

    const res = await this.request('GET', path, { headers, raw: true });
    if (res.statusCode >= 400) {
      const text = (await WebDavAdapter.readBody(res)).toString('utf8');
      const err = new Error(`GET ${path} failed: ${res.statusCode} ${res.statusMessage}${this._explain(text)}`);
      err.status = res.statusCode;
      throw err;
    }
    if (start > 0 && res.statusCode !== 206) {
      // The server ignored the Range and is about to send the whole file.
      // Continuing would append the start of the file onto a partial download.
      res.destroy();
      throw new Error(`Server ignored the Range header (answered ${res.statusCode}); resume is not possible`);
    }
    const out = new PassThrough();
    res.pipe(out);
    res.on('error', (e) => out.destroy(e));
    return out;
  }

  async createWriteStream(p, opts = {}) {
    const path = this.normalize(p);
    // A PUT replaces the whole resource: RFC 4918 has no way to write at an
    // offset, and no server implements one portably. Quietly dropping the
    // offset would upload the tail of a file over the top of the whole one and
    // report success, so say what cannot be done instead.
    if (Number(opts.start || 0) > 0 || opts.append) {
      throw new Error('WebDAV replaces a resource on every PUT and cannot write at an offset; '
        + 'this upload has to start from the beginning');
    }
    return new PutStream(this, path, opts);
  }
}

module.exports = {
  WebDavAdapter,
  parseMultistatus,
  parseXml,
  findAll,
  parseAuthenticate,
  buildDigestHeader,
  encodePath,
  encodeSegment,
};
