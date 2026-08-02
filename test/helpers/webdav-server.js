// webdav-server.js — a REAL WebDAV server on node:http, backed by a real
// temporary directory.
//
// This exists because a unit test that feeds captured XML to `parseMultistatus`
// proves the parser and nothing else. It does not prove that the adapter sends
// a Depth header the server accepts, that its percent-encoding survives a round
// trip, that its Digest response hashes what the server hashed, or that a Range
// request actually produces 206. Only a server that speaks HTTP back does that.
//
// Deliberate design points:
//
//   * The namespace style is switchable. `namespace: 'prefix'` answers the way
//     Apache mod_dav does — `D:multistatus` with live properties carried under
//     a *second* prefix (`lp1:`) bound to the same `DAV:` URI. `'default'`
//     answers the way sabre/dav and IIS do, with `xmlns="DAV:"` and no prefix
//     at all. A client that string-matches on `D:href` passes one and fails the
//     other, which is exactly the bug this switch is here to catch.
//   * Every response carries one 404 propstat alongside the 200 one, because
//     real servers do and a client that reads values out of the 404 block gets
//     empty sizes and epoch timestamps.
//   * Hrefs are encoded with `encodeURIComponent` per segment — deliberately a
//     *different* escaping from the adapter's own, so the adapter has to decode
//     properly instead of comparing the string it sent.
//   * Basic and Digest are both implemented as challenge/response, so the
//     adapter's credentials are verified by arithmetic the server did itself.
//
// Nothing here is a mock: bytes land in a real directory and `fs` is the only
// source of truth for what a PROPFIND reports.
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/** Percent-encode a URL path segment by segment (never the separators). */
function encodeHrefPath(p) {
  return p.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

/** Split a header on commas that are not inside a quoted string. */
function splitParams(text) {
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

function parseDigestAuthorization(header) {
  const params = {};
  for (const part of splitParams(header.replace(/^Digest\s+/i, ''))) {
    const m = /^\s*([A-Za-z0-9._-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(.*?))\s*$/.exec(part);
    if (!m) continue;
    params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return params;
}

/**
 * Start the server.
 *
 * @param options.root        directory to serve (created if absent)
 * @param options.auth        'none' | 'basic' | 'digest'
 * @param options.user        expected user name
 * @param options.password    expected password (never logged)
 * @param options.realm       authentication realm
 * @param options.namespace   'prefix' | 'default' — how DAV: is declared
 * @param options.quota       { available, used } to answer RFC 4331 properties
 * @param options.acceptRanges  advertise byte ranges (default true)
 * @returns { port, origin, root, requests, close() }
 */
async function startWebDavServer(options = {}) {
  const root = options.root;
  if (!root) throw new Error('startWebDavServer needs a root directory');
  await fsp.mkdir(root, { recursive: true });

  const auth = options.auth || 'none';
  const user = options.user || 'dav';
  const password = options.password || '';
  const realm = options.realm || 'WinSCP Material Test';
  const nsStyle = options.namespace === 'default' ? 'default' : 'prefix';
  const acceptRanges = options.acceptRanges !== false;
  const opaque = crypto.randomBytes(8).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  /** Every request the server saw, so a test can assert on the wire, not the API. */
  const requests = [];
  const state = { challenges: 0, lastNc: 0, schemes: new Set() };

  /**
   * Fault injection.
   *
   * `killPutAfter` is a byte count: once that many bytes of a PUT body have
   * arrived the server tears the socket down without answering. That is what a
   * dropped VPN, a proxy timeout or a restarted server looks like from the
   * client, and it is the one moment a streaming upload has no response to
   * wait for — so it is where an unhandled rejection hides.
   */
  const faults = { killPutAfter: null };

  const sockets = new Set();

  // -- filesystem mapping ---------------------------------------------------

  const fsPathOf = (urlPath) => {
    let decoded;
    try { decoded = decodeURIComponent(urlPath); } catch { return null; }
    const parts = [];
    for (const seg of decoded.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (parts.length) parts.pop(); else return null; continue; }
      parts.push(seg);
    }
    return path.join(root, ...parts);
  };

  const cleanUrlPath = (urlPath) => {
    let decoded;
    try { decoded = decodeURIComponent(urlPath); } catch { decoded = urlPath; }
    const parts = decoded.split('/').filter((s) => s && s !== '.');
    return `/${parts.join('/')}`;
  };

  // -- property XML ---------------------------------------------------------

  const propsFor = (urlPath, st) => {
    const isDir = st.isDirectory();
    const href = encodeHrefPath(urlPath === '/' ? '/' : urlPath.replace(/\/+$/, '')) + (isDir && urlPath !== '/' ? '/' : '');
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const live = [
      `<%P%displayname>${xmlEscape(path.basename(urlPath) || '/')}</%P%displayname>`,
      isDir
        ? '<%P%resourcetype><%P%collection/></%P%resourcetype>'
        : '<%P%resourcetype/>',
      isDir ? '' : `<%P%getcontentlength>${st.size}</%P%getcontentlength>`,
      `<%P%getlastmodified>${new Date(st.mtimeMs).toUTCString()}</%P%getlastmodified>`,
      `<%P%creationdate>${new Date(st.birthtimeMs || st.mtimeMs).toISOString()}</%P%creationdate>`,
      `<%P%getetag>${xmlEscape(etag)}</%P%getetag>`,
      isDir ? '' : '<%P%getcontenttype>application/octet-stream</%P%getcontenttype>',
    ].filter(Boolean);

    if (options.quota && urlPath === '/') {
      live.push(`<%P%quota-available-bytes>${options.quota.available}</%P%quota-available-bytes>`);
      live.push(`<%P%quota-used-bytes>${options.quota.used}</%P%quota-used-bytes>`);
    }

    // Foreign-namespace properties, which every real server emits.
    //
    // These deliberately COLLIDE by local name with the DAV: properties the
    // adapter actually reads, and are emitted *after* the real ones, so a
    // parser that keys its property map on the local name alone takes the
    // foreign value as the last writer and reports a 999999999-byte file that
    // is also a collection. A property with a name nothing else uses (mod_dav's
    // `executable`) cannot catch that, because there is nothing to confuse it
    // with — so one of those is included as well, and the collisions do the
    // actual work.
    const APACHE = 'http://apache.org/dav/props/';
    const foreign = `<X:executable xmlns:X="${APACHE}">F</X:executable>`
      + `<X:getcontentlength xmlns:X="${APACHE}">999999999</X:getcontentlength>`
      + `<X:resourcetype xmlns:X="${APACHE}"><X:collection/></X:resourcetype>`
      + `<X:getlastmodified xmlns:X="${APACHE}">Thu, 01 Jan 1970 00:00:00 GMT</X:getlastmodified>`
      + `<X:displayname xmlns:X="${APACHE}">WRONG</X:displayname>`
      + `<X:quota-available-bytes xmlns:X="${APACHE}">424242</X:quota-available-bytes>`
      + `<X:quota-used-bytes xmlns:X="${APACHE}">434343</X:quota-used-bytes>`;

    // The properties the client asked for that this server does not have. Real
    // servers report them in their own 404 propstat; a client that reads values
    // out of it sees zeroes.
    const absent = options.quota && urlPath === '/'
      ? ''
      : '<%P%quota-available-bytes/><%P%quota-used-bytes/>';

    return { href, live: live.join(''), foreign, absent };
  };

  const multistatus = (entries) => {
    const usePrefix = nsStyle === 'prefix';
    const D = usePrefix ? 'D:' : '';
    // mod_dav really does answer with live properties under a second prefix
    // bound to the same namespace URI; a parser that keys on the prefix breaks.
    const P = usePrefix ? 'lp1:' : '';
    const decl = usePrefix
      ? 'xmlns:D="DAV:" xmlns:lp1="DAV:"'
      : 'xmlns="DAV:"';

    const body = entries.map(({ href, live, foreign, absent }) => `
  <${D}response>
    <${D}href>${xmlEscape(href)}</${D}href>
    <${D}propstat>
      <${D}prop>${live.replace(/%P%/g, P)}${foreign}</${D}prop>
      <${D}status>HTTP/1.1 200 OK</${D}status>
    </${D}propstat>${absent ? `
    <${D}propstat>
      <${D}prop>${absent.replace(/%P%/g, P)}</${D}prop>
      <${D}status>HTTP/1.1 404 Not Found</${D}status>
    </${D}propstat>` : ''}
  </${D}response>`).join('');

    return `<?xml version="1.0" encoding="utf-8"?>
<${D}multistatus ${decl}>${body}
</${D}multistatus>
`;
  };

  // -- authentication -------------------------------------------------------

  /** @returns null when the request is authenticated, or a challenge to send. */
  const checkAuth = (req) => {
    if (auth === 'none') return null;
    const header = req.headers.authorization || '';

    if (auth === 'basic') {
      const m = /^Basic\s+(.+)$/i.exec(header);
      if (m) {
        const [u, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
        if (u === user && rest.join(':') === password) { state.schemes.add('Basic'); return null; }
      }
      return `Basic realm="${realm}", charset="UTF-8"`;
    }

    // Digest, RFC 7616 with qop=auth. The server recomputes the whole hash
    // chain, so the adapter's header is verified rather than merely parsed.
    const digestChallenge = `Digest realm="${realm}", qop="auth", algorithm=MD5, `
      + `nonce="${nonce}", opaque="${opaque}"`;
    if (!/^Digest\s/i.test(header)) return digestChallenge;

    const p = parseDigestAuthorization(header);
    if (p.username !== user || p.realm !== realm || p.nonce !== nonce) return digestChallenge;
    if (p.opaque !== opaque) return digestChallenge;
    if (!p.uri || p.uri !== req.url) return digestChallenge;
    // Replay protection: the nonce count must strictly increase.
    const nc = parseInt(p.nc || '0', 16);
    if (!Number.isFinite(nc) || nc <= state.lastNc) return `${digestChallenge}, stale=true`;

    const ha1 = md5(`${user}:${realm}:${password}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    const expected = p.qop
      ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`)
      : md5(`${ha1}:${p.nonce}:${ha2}`);
    if (expected !== p.response) return digestChallenge;

    state.lastNc = nc;
    state.schemes.add('Digest');
    return null;
  };

  // -- request handling -----------------------------------------------------

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const send = (res, status, headers = {}, body = '') => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    res.writeHead(status, { 'Content-Length': String(buf.length), ...headers });
    res.end(buf);
  };

  const server = http.createServer(async (req, res) => {
    const urlPath = cleanUrlPath(req.url.split('?')[0]);
    requests.push({ method: req.method, url: req.url, path: urlPath, headers: { ...req.headers } });

    const challenge = checkAuth(req);
    if (challenge) {
      state.challenges += 1;
      // The body must be drained or the socket stalls on a request that had one.
      await readBody(req);
      send(res, 401, { 'WWW-Authenticate': challenge, 'Content-Type': 'text/plain' }, 'Unauthorized');
      return;
    }

    const target = fsPathOf(req.url.split('?')[0]);
    if (target === null) { await readBody(req); send(res, 403, {}, 'Forbidden'); return; }

    try {
      await handle(req, res, urlPath, target);
    } catch (err) {
      if (!res.headersSent) {
        send(res, 500, { 'Content-Type': 'text/plain' }, `Server error: ${err.message}`);
      } else {
        res.destroy();
      }
    }
  });

  async function statOrNull(p) {
    try { return await fsp.stat(p); } catch { return null; }
  }

  async function handle(req, res, urlPath, target) {
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') {
      await readBody(req);
      send(res, 200, {
        DAV: '1, 2, 3',
        // Plenty of DAV endpoints (SharePoint's read-only shares, several
        // object-store gateways) advertise a reduced verb set. The adapter is
        // supposed to believe the Allow header rather than assume COPY and
        // MOVE exist, so the list is configurable.
        Allow: options.allow
          || 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK',
        'MS-Author-Via': 'DAV',
        Server: 'winscp-material-test-dav',
      });
      return;
    }

    if (method === 'PROPFIND') {
      await readBody(req);
      const st = await statOrNull(target);
      if (!st) { send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found'); return; }
      const depth = String(req.headers.depth === undefined ? 'infinity' : req.headers.depth);
      if (depth !== '0' && depth !== '1') {
        send(res, 403, { 'Content-Type': 'text/plain' }, 'Depth infinity is not allowed here');
        return;
      }
      const entries = [propsFor(urlPath, st)];
      if (depth === '1' && st.isDirectory()) {
        for (const name of (await fsp.readdir(target)).sort()) {
          const childFs = path.join(target, name);
          const childSt = await statOrNull(childFs);
          if (!childSt) continue;
          const childUrl = urlPath === '/' ? `/${name}` : `${urlPath}/${name}`;
          entries.push(propsFor(childUrl, childSt));
        }
      }
      send(res, 207, { 'Content-Type': 'application/xml; charset="utf-8"' }, multistatus(entries));
      return;
    }

    if (method === 'HEAD' || method === 'GET') {
      await readBody(req);
      const st = await statOrNull(target);
      if (!st) { send(res, 404, { 'Content-Type': 'text/plain' }, 'Not Found'); return; }
      const common = {
        'Last-Modified': new Date(st.mtimeMs).toUTCString(),
        ETag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      };
      if (acceptRanges) common['Accept-Ranges'] = 'bytes';

      if (st.isDirectory()) {
        // A collection has no body; answering 200 with zero bytes is what
        // mod_dav does for HEAD and is what makes `Accept-Ranges` discoverable.
        if (method === 'HEAD') { send(res, 200, { ...common, 'Content-Type': 'text/html' }); return; }
        send(res, 405, { Allow: 'PROPFIND, DELETE, MOVE, COPY, OPTIONS' }, 'Not a file');
        return;
      }

      const range = acceptRanges ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '')) : null;
      if (range) {
        const start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
        const end = range[1] === '' ? st.size - 1
          : (range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1));
        if (start >= st.size || start > end) {
          send(res, 416, { 'Content-Range': `bytes */${st.size}` }, '');
          return;
        }
        const length = end - start + 1;
        res.writeHead(206, {
          ...common,
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': String(length),
        });
        if (method === 'HEAD') { res.end(); return; }
        fs.createReadStream(target, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        ...common,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(st.size),
      });
      if (method === 'HEAD') { res.end(); return; }
      fs.createReadStream(target).pipe(res);
      return;
    }

    if (method === 'PUT' && faults.killPutAfter !== null) {
      let seen = 0;
      req.on('data', (c) => {
        seen += c.length;
        if (seen >= faults.killPutAfter) req.socket.destroy();
      });
      return;
    }

    if (method === 'PUT') {
      const parent = path.dirname(target);
      const parentSt = await statOrNull(parent);
      if (!parentSt || !parentSt.isDirectory()) {
        await readBody(req);
        send(res, 409, { 'Content-Type': 'text/plain' }, 'Conflict: parent collection does not exist');
        return;
      }
      const existing = await statOrNull(target);
      if (existing && existing.isDirectory()) {
        await readBody(req);
        send(res, 405, {}, 'Cannot PUT over a collection');
        return;
      }
      if (req.headers['if-none-match'] === '*' && existing) {
        await readBody(req);
        send(res, 412, {}, 'Precondition Failed');
        return;
      }
      const body = await readBody(req);
      await fsp.writeFile(target, body);
      const st = await fsp.stat(target);
      send(res, existing ? 204 : 201, {
        ETag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      });
      return;
    }

    if (method === 'MKCOL') {
      const body = await readBody(req);
      if (body.length) { send(res, 415, {}, 'MKCOL with a body is not supported'); return; }
      const existing = await statOrNull(target);
      if (existing) { send(res, 405, {}, 'Already exists'); return; }
      const parentSt = await statOrNull(path.dirname(target));
      if (!parentSt || !parentSt.isDirectory()) { send(res, 409, {}, 'Conflict'); return; }
      await fsp.mkdir(target);
      send(res, 201, {});
      return;
    }

    if (method === 'DELETE') {
      await readBody(req);
      const st = await statOrNull(target);
      if (!st) { send(res, 404, {}, 'Not Found'); return; }
      await fsp.rm(target, { recursive: true, force: true });
      send(res, 204, {});
      return;
    }

    if (method === 'MOVE' || method === 'COPY') {
      await readBody(req);
      const st = await statOrNull(target);
      if (!st) { send(res, 404, {}, 'Not Found'); return; }
      const destHeader = req.headers.destination;
      if (!destHeader) { send(res, 400, {}, 'Destination header required'); return; }
      let destPath;
      try {
        destPath = new URL(destHeader, `http://${req.headers.host}/`).pathname;
      } catch { send(res, 400, {}, 'Bad Destination'); return; }
      const destFs = fsPathOf(destPath);
      if (destFs === null) { send(res, 403, {}, 'Forbidden destination'); return; }

      const destSt = await statOrNull(destFs);
      const overwrite = String(req.headers.overwrite || 'T').toUpperCase() !== 'F';
      if (destSt && !overwrite) { send(res, 412, {}, 'Precondition Failed'); return; }
      const destParent = await statOrNull(path.dirname(destFs));
      if (!destParent || !destParent.isDirectory()) { send(res, 409, {}, 'Conflict'); return; }
      if (destSt) await fsp.rm(destFs, { recursive: true, force: true });

      if (method === 'MOVE') {
        await fsp.rename(target, destFs);
      } else {
        await fsp.cp(target, destFs, { recursive: true });
      }
      send(res, destSt ? 204 : 201, {});
      return;
    }

    await readBody(req);
    send(res, 405, { Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, COPY, MOVE' }, 'Method Not Allowed');
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  // Port 0: the OS picks a free port, so the suite never collides with a
  // service already running on the machine and never flakes in CI.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    root,
    requests,
    state,
    faults,
    namespace: nsStyle,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startWebDavServer, encodeHrefPath };
