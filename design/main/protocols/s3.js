// s3.js — Amazon S3 and S3-compatible endpoints (MinIO, Wasabi, Backblaze B2,
// Ceph RGW, Storj, …), spoken directly over HTTPS.
//
// No AWS SDK. The SDK is tens of megabytes for what is, at this level, a REST
// API and one signing algorithm; bundling it into an Electron app to list
// objects and PUT bytes is not a trade worth making. Signature Version 4 is
// implemented here from the specification and is exported so it can be tested
// against AWS's own published vectors — see test/protocols-s3sig.test.js.
//
// S3 has no directories. What the panel shows as a folder is either a common
// prefix returned by a delimited listing, or a zero-byte key ending in '/'
// (the marker every console and client creates so an "empty folder" can exist
// at all). Both are rendered as directories; the marker itself is never
// rendered as a file, because a folder that contains a 0-byte file named after
// itself is confusing and wrong.
'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough, Writable } = require('stream');
const { Adapter, entry } = require('./base');

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const ALGORITHM = 'AWS4-HMAC-SHA256';

// S3 rejects parts smaller than 5 MiB (except the last) and allows at most
// 10 000 of them, which together set the floor and the scaling rule below.
// These are WinSCP's own S3MinMultiPartChunkSize / S3MaxMultiPartChunks, and
// the part size is computed the same way it is in core/S3FileSystem.cpp: the
// floor unless the object is big enough that 10 000 parts would not cover it.
const MIN_PART_SIZE = 5 * 1024 * 1024;
const MAX_PARTS = 10000;

/** The part size WinSCP would use for an object of `size` bytes. */
function partSizeFor(size) {
  if (!size || size <= 0) return MIN_PART_SIZE;
  const parts = Math.min(MAX_PARTS, Math.max(1, Math.ceil(size / MIN_PART_SIZE)));
  return Math.max(MIN_PART_SIZE, Math.ceil(size / parts));
}
// CopyObject cannot copy more than 5 GiB in one call; past that it is a
// multipart copy or nothing.
const MAX_SINGLE_COPY = 5 * 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Signature Version 4
// ---------------------------------------------------------------------------

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * RFC 3986 percent-encoding, which is *not* what encodeURIComponent does:
 * it leaves `!'()*` alone and AWS requires them encoded.
 */
function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(ch);
    if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a)
      || (ch >= 0x30 && ch <= 0x39) || c === '-' || c === '_' || c === '.' || c === '~') {
      out += c;
    } else if (c === '/' && !encodeSlash) {
      out += c;
    } else {
      out += `%${ch.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * Is this host an IP literal rather than a name?
 *
 * TLS forbids an SNI server name that is an IP address, and Node throws rather
 * than dropping it — so an endpoint addressed by IP has to be connected to
 * without SNI, not refused.
 */
function isIpLiteral(host) {
  const bare = String(host || '').replace(/^\[|\]$/g, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':');
}

/** `2020-03-03T09:22:00Z` → `20200303T092200Z`, the only date format SigV4 uses. */
function amzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * The canonical query string: keys and values encoded, sorted by encoded key
 * and then by encoded value. A parameter with no value still gets its `=`.
 *
 * @param query  object, or an array of [key, value] pairs for repeated keys
 */
function canonicalQuery(query) {
  if (!query) return '';
  const pairs = Array.isArray(query)
    ? query.map(([k, v]) => [k, v])
    : Object.entries(query).filter(([, v]) => v !== undefined && v !== null);
  return pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(v === true || v === '' || v === undefined ? '' : String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Canonical headers + the signed-header list.
 *
 * Header names are lower-cased and sorted; values have their surrounding
 * whitespace removed and internal runs of spaces collapsed — but only outside
 * quotes, per the specification.
 */
function canonicalHeaders(headers) {
  const norm = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    norm.push([name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')]);
  }
  norm.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: norm.map(([n, v]) => `${n}:${v}\n`).join(''),
    signed: norm.map(([n]) => n).join(';'),
  };
}

/**
 * Build the canonical request.
 *
 * `pathEncoded` matters: every AWS service normalizes and double-encodes the
 * path except S3, which signs the path exactly as it is sent. Getting this
 * wrong produces a SignatureDoesNotMatch on any key containing a space or a
 * plus sign, and on nothing else — which is a miserable bug to chase.
 */
function createCanonicalRequest({ method, path: uriPath, query, headers, payloadHash, doubleEncodePath = false }) {
  const rawPath = uriPath || '/';
  const canonicalUri = doubleEncodePath
    ? uriEncode(uriEncode(rawPath, false), false)
    : uriEncode(rawPath, false);
  const { canonical, signed } = canonicalHeaders(headers);
  const text = [
    method,
    canonicalUri || '/',
    canonicalQuery(query),
    canonical,
    signed,
    payloadHash,
  ].join('\n');
  return { canonicalRequest: text, signedHeaders: signed };
}

function createStringToSign({ date, region, service, canonicalRequest }) {
  const stamp = amzDate(date);
  const scope = `${stamp.slice(0, 8)}/${region}/${service}/aws4_request`;
  return {
    stringToSign: [ALGORITHM, stamp, scope, sha256hex(canonicalRequest)].join('\n'),
    credentialScope: scope,
    amzDate: stamp,
  };
}

/** The four chained HMACs that turn a secret key into a scoped signing key. */
function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Sign a request. Returns the pieces rather than mutating anything, so a test
 * can compare the canonical request and the string to sign against AWS's
 * published examples — which is the only way to be confident about this code
 * short of talking to S3.
 *
 * `headers` must already contain `host` and `x-amz-date`; anything else in it
 * gets signed too.
 */
function signRequestV4(req) {
  const {
    method, path: uriPath, query, headers, service, region,
    accessKeyId, secretAccessKey, sessionToken, doubleEncodePath,
  } = req;
  const date = req.date || new Date();
  const payloadHash = req.payloadHash
    || (req.body !== undefined && req.body !== null ? sha256hex(req.body) : EMPTY_SHA256);

  const all = { ...headers };
  if (sessionToken) all['x-amz-security-token'] = sessionToken;

  const { canonicalRequest, signedHeaders } = createCanonicalRequest({
    method, path: uriPath, query, headers: all, payloadHash, doubleEncodePath,
  });
  const { stringToSign, credentialScope, amzDate: stamp } = createStringToSign({
    date, region, service, canonicalRequest,
  });
  const key = deriveSigningKey(secretAccessKey, stamp.slice(0, 8), region, service);
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  return {
    signature,
    canonicalRequest,
    stringToSign,
    credentialScope,
    amzDate: stamp,
    signedHeaders,
    payloadHash,
    authorization: `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers: { ...all, Authorization: `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
  };
}

// ---------------------------------------------------------------------------
// A minimal XML reader for S3 responses
// ---------------------------------------------------------------------------

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlText(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Keep malformed XML entities as text. String.fromCodePoint throws for
      // values outside Unicode's scalar range, which would hide the actual
      // S3 response error behind an unexpected parser exception.
      const validCodePoint = Number.isInteger(code) && code >= 0 && code <= 0x10FFFF
        && !(code >= 0xD800 && code <= 0xDFFF);
      return validCodePoint ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[body] === undefined ? whole : XML_ENTITIES[body];
  });
}

/**
 * Parse an S3 XML document.
 *
 * S3 uses one default namespace and no mixed content, so prefixes are simply
 * stripped — unlike WebDAV, where prefix resolution actually matters.
 */
function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const src = String(text);
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { stack[stack.length - 1].text += decodeXmlText(src.slice(i)); break; }
    if (lt > i) stack[stack.length - 1].text += decodeXmlText(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      stack[stack.length - 1].text += src.slice(lt + 9, e < 0 ? src.length : e);
      i = e < 0 ? src.length : e + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue;
    }

    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    let raw = src.slice(lt + 1, gt);
    i = gt + 1;

    if (raw[0] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const selfClosing = raw.endsWith('/');
    if (selfClosing) raw = raw.slice(0, -1);

    const nameMatch = /^([^\s/>]+)/.exec(raw);
    if (!nameMatch) continue;
    const qname = nameMatch[1];
    const attrs = {};
    const attrRe = /([^\s=/<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = attrRe.exec(raw.slice(qname.length))) !== null) {
      attrs[a[1]] = decodeXmlText(a[2] !== undefined ? a[2] : a[3]);
    }
    const node = {
      name: qname.includes(':') ? qname.slice(qname.indexOf(':') + 1) : qname,
      attrs, children: [], text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function kids(node, name) { return node ? node.children.filter((c) => c.name === name) : []; }
function kid(node, name) { return node ? node.children.find((c) => c.name === name) || null : null; }
function textOf(node, name) { const c = kid(node, name); return c ? c.text.trim() : ''; }

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Parse an AWS shared-credentials/config INI file into `{ profile: {k: v} }`. */
function parseAwsIni(text) {
  const out = {};
  let section = null;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.replace(/[;#].*$/, '').trim();
    if (!trimmed) continue;
    const head = /^\[\s*(.+?)\s*\]$/.exec(trimmed);
    if (head) {
      // ~/.aws/config prefixes non-default profiles with "profile ".
      section = head[1].replace(/^profile\s+/, '');
      out[section] = out[section] || {};
      continue;
    }
    if (!section) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[section][trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function readAwsProfile(profileName, home) {
  const dir = path.join(home || os.homedir(), '.aws');
  const read = (file) => {
    try { return parseAwsIni(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return {}; }
  };
  const creds = read('credentials');
  const config = read('config');
  const name = profileName || process.env.AWS_PROFILE || 'default';
  return { ...(config[name] || {}), ...(creds[name] || {}), _profile: name };
}

// ---------------------------------------------------------------------------
// Upload stream
// ---------------------------------------------------------------------------

/**
 * A Writable that becomes a simple PutObject for small files and a multipart
 * upload for large ones, decided by how much data actually arrives — the
 * caller does not always know the size in advance (a pipe from a filter, a
 * synchronized folder), and guessing wrong either wastes three round trips or
 * buffers a 40 GB file in memory.
 *
 * A failure aborts the multipart upload, so a broken transfer does not leave
 * parts on the account quietly costing money forever.
 */
class S3UploadStream extends Writable {
  constructor(adapter, bucket, key, opts = {}) {
    super({ highWaterMark: 1 << 20 });
    this.adapter = adapter;
    this.bucket = bucket;
    this.key = key;
    this.opts = opts;
    this.buffer = [];
    this.buffered = 0;
    this.uploadId = null;
    this.parts = [];
    this.partNumber = 0;
    this.result = null;
    this.abortPromise = null;
    this.signal = opts.signal || null;
    if (this.signal && this.signal.aborted) this.destroy(new Error('S3 upload cancelled'));
    if (this.signal) this.signal.addEventListener('abort', () => this.destroy(new Error('S3 upload cancelled')), { once: true });
    // Keep every part above S3's 5 MiB floor while staying under the 10 000
    // part ceiling for whatever size the caller did tell us about.
    this.partSize = partSizeFor(opts.size);
  }

  _write(chunk, enc, cb) {
    this.buffer.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered < this.partSize) { cb(); return; }
    this._flushPart().then(() => cb(), cb);
  }

  async _flushPart() {
    if (this.signal && this.signal.aborted) throw new Error('S3 upload cancelled');
    const body = Buffer.concat(this.buffer, this.buffered);
    this.buffer = [];
    this.buffered = 0;
    if (!this.uploadId) this.uploadId = await this.adapter._createMultipartUpload(this.bucket, this.key, this.opts);
    this.partNumber += 1;
    const etag = await this.adapter._uploadPart(this.bucket, this.key, this.uploadId, this.partNumber, body);
    this.parts.push({ partNumber: this.partNumber, etag });
  }

  _final(cb) {
    const finish = async () => {
      if (this.signal && this.signal.aborted) throw new Error('S3 upload cancelled');
      if (!this.uploadId) {
        // Everything fit in the buffer — one PutObject, no multipart dance.
        const body = Buffer.concat(this.buffer, this.buffered);
        this.result = await this.adapter._putObject(this.bucket, this.key, body, this.opts);
        return;
      }
      if (this.buffered > 0) await this._flushPart();
      this.result = await this.adapter._completeMultipartUpload(this.bucket, this.key, this.uploadId, this.parts);
    };
    finish().then(() => cb(), async (err) => {
      if (this.uploadId) {
        await this._abortMultipartUpload();
      }
      cb(err);
    });
  }

  _destroy(err, cb) {
    if (err && this.uploadId) {
      this._abortMultipartUpload()
        .finally(() => cb(err));
      return;
    }
    cb(err);
  }

  _abortMultipartUpload() {
    if (!this.abortPromise) {
      this.abortPromise = Promise.resolve()
        .then(() => this.adapter._abortMultipartUpload(this.bucket, this.key, this.uploadId));
    }
    return this.abortPromise.catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

class S3Adapter extends Adapter {
  /**
   * @param session  a site record shaped like SESSION_DEFAULTS
   * @param options  host services injected by session.js:
   *                 `password`       the secret access key, already decrypted
   *                 `certVerifier`   (host, cert, problem) → boolean|Promise
   *                 `log(level, message)`
   *                 `homeDir`        override for ~/.aws (tests)
   */
  constructor(session, options = {}) {
    super(session);
    this.options = options;
    // WinSCP decides S3's transport from the session's Encryption setting
    // (TSessionData::Ftps) and derives the *default* port from that choice —
    // 443 with encryption, 80 without (SessionData.cpp, GetDefaultPort). The
    // setting is the cause and the port is the consequence, never the other way
    // round: a self-hosted endpoint (MinIO, Ceph RGW, a test server) listens on
    // 9000 or an ephemeral port at least as often as it listens on 80, and
    // keying off the port alone makes every one of them unreachable.
    //
    // Our session record carries one shared `ftps` field whose default is
    // 'none' for every protocol, while WinSCP defaults S3 to implicit TLS. So
    // "no encryption" is only believed when the site is not sitting on the
    // HTTPS port; otherwise an S3 site left at its defaults would quietly drop
    // to plain HTTP, which is a downgrade rather than a default.
    const declaredPort = Number(session.portNumber) || 0;
    const encrypted = !!(session.ftps && session.ftps !== 'none');
    this.secure = encrypted || declaredPort === 443 || declaredPort === 0;
    this.region = session.s3DefaultRegion || '';
    this.endpoint = session.hostName || '';
    this.port = Number(session.portNumber) || (this.secure ? 443 : 80);
    this.credentials = null;
    this._agent = null;
    this._pinned = null;
    this._bucketRegions = new Map();
    this.caps = {
      ...this.caps,
      rights: false,        // S3 has ACLs and policies, not unix permissions
      owner: false,
      symlink: false,
      exec: false,
      // WinSCP answers false to fcResumeSupport and fcParallelFileTransfers for
      // S3 (core/S3FileSystem.cpp), and so must we. GetObject does honour Range
      // — `createReadStream` uses it — but `caps.resume` is read by the
      // transfer queue for BOTH sides of a copy and means "this backend can
      // continue a transfer at an offset". There is no positioned write in S3:
      // every PutObject replaces the whole object. Claiming otherwise makes the
      // queue write a file's tail into a `.filepart` and rename it over the
      // target, or split one upload across parallel streams that each overwrite
      // the last — both of which silently produce a truncated object.
      resume: false,
      timestamp: false,     // Last-Modified is set by S3 and cannot be chosen
      checksum: true,       // ETag is an MD5 for single-part objects
      copyRemote: true,     // CopyObject is server side
      nativeMove: false,    // there is no rename: a move is a copy then delete
      rename: true,
      move: true,
      recycleBin: false,
      hiddenFiles: true,
      spaceInfo: false,     // buckets have no size limit to report
    };
  }

  get protocolName() { return 'Amazon S3'; }

  _log(level, message) {
    if (this.options.log) this.options.log(level, message);
    this.emit('log', { level, message });
  }

  // -- credentials ---------------------------------------------------------

  /**
   * Resolve credentials in WinSCP's order: what the site says, then the
   * environment (only when the site opted in), then the named profile. An
   * assumed role is layered on top of whichever of those answered.
   *
   * Nothing here is ever logged; the only thing reported is *where* the
   * credentials came from.
   */
  async _resolveCredentials() {
    const s = this.session;
    let source = 'site';
    let accessKeyId = s.userName || '';
    let secretAccessKey = this.options.password !== undefined ? this.options.password : (s.password || '');
    let sessionToken = s.s3SessionToken || '';
    let region = s.s3DefaultRegion || '';

    if ((!accessKeyId || !secretAccessKey) && s.s3CredentialsEnv) {
      const env = process.env;
      if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
        accessKeyId = env.AWS_ACCESS_KEY_ID;
        secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
        sessionToken = env.AWS_SESSION_TOKEN || env.AWS_SECURITY_TOKEN || sessionToken;
        region = region || env.AWS_REGION || env.AWS_DEFAULT_REGION || '';
        source = 'environment';
      }
    }

    if ((!accessKeyId || !secretAccessKey) && (s.s3Profile || s.s3CredentialsEnv)) {
      const profile = readAwsProfile(s.s3Profile, this.options.homeDir);
      if (profile.aws_access_key_id && profile.aws_secret_access_key) {
        accessKeyId = profile.aws_access_key_id;
        secretAccessKey = profile.aws_secret_access_key;
        sessionToken = profile.aws_session_token || sessionToken;
        region = region || profile.region || '';
        source = `profile ${profile._profile}`;
      }
    }

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('No S3 credentials: set the access key and secret on the site, '
        + 'enable "use environment credentials", or name a profile from ~/.aws/credentials');
    }

    this.region = this.region || region || 'us-east-1';
    this.credentials = { accessKeyId, secretAccessKey, sessionToken, expiresAt: 0 };
    this._log('info', `S3 credentials taken from ${source}`);

    if (s.s3RoleArn) await this._assumeRole();
  }

  /** STS AssumeRole, signed with the base credentials resolved above. */
  async _assumeRole() {
    const s = this.session;
    const body = new URLSearchParams({
      Action: 'AssumeRole',
      Version: '2011-06-15',
      RoleArn: s.s3RoleArn,
      RoleSessionName: (this.options.roleSessionName || `winscp-material-${Date.now()}`).slice(0, 64),
      DurationSeconds: String(this.options.roleDurationSeconds || 3600),
    }).toString();

    const host = this.options.stsEndpoint || `sts.${this.region}.amazonaws.com`;
    const res = await this._httpSigned({
      method: 'POST',
      host,
      port: 443,
      secure: true,
      service: 'sts',
      region: this.region,
      path: '/',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: Buffer.from(body, 'utf8'),
    });
    const text = res.body.toString('utf8');
    if (res.status >= 400) throw new Error(`AssumeRole failed: ${this._explain(text, res.status)}`);

    const doc = parseXml(text);
    const creds = kid(kid(kid(doc, 'AssumeRoleResponse'), 'AssumeRoleResult'), 'Credentials');
    if (!creds) throw new Error('AssumeRole returned no credentials');
    // STS can return a syntactically valid response whose Credentials node is
    // incomplete (for example when a proxy or test double drops one field).
    // The core requires every temporary-credential field before accepting the
    // role, because signing with an empty secret would otherwise fail later as
    // an unrelated S3 authorization error.
    const required = ['AccessKeyId', 'SecretAccessKey', 'SessionToken', 'Expiration'];
    const missing = required.find((name) => !textOf(creds, name));
    if (missing) throw new Error(`AssumeRole returned incomplete credentials: missing ${missing}`);
    const expirationText = textOf(creds, 'Expiration');
    const expiresAt = Date.parse(expirationText);
    if (!Number.isFinite(expiresAt)) {
      throw new Error('AssumeRole returned invalid credentials: Expiration is not an ISO date');
    }
    this.credentials = {
      accessKeyId: textOf(creds, 'AccessKeyId'),
      secretAccessKey: textOf(creds, 'SecretAccessKey'),
      sessionToken: textOf(creds, 'SessionToken'),
      expiresAt,
      base: this.credentials,
    };
    this._log('info', `Assumed role ${s.s3RoleArn}`);
  }

  async _ensureCredentials() {
    if (!this.credentials) { await this._resolveCredentials(); return; }
    // Refresh an assumed role a minute before it lapses, so a long transfer
    // does not die at the 59th minute.
    if (this.credentials.expiresAt && Date.now() > this.credentials.expiresAt - 60000) {
      this.credentials = this.credentials.base || this.credentials;
      await this._assumeRole();
    }
  }

  // -- addressing ----------------------------------------------------------

  _defaultEndpoint() {
    return this.endpoint || (this.region === 'us-east-1' ? 's3.amazonaws.com' : `s3.${this.region}.amazonaws.com`);
  }

  /**
   * Where a request for a given bucket goes, and what path prefix it carries.
   *
   * Virtual-host style (`bucket.s3.amazonaws.com`) is what AWS wants and what
   * a bucket policy usually assumes; path style (`endpoint/bucket`) is what
   * most self-hosted and compatible servers speak, and the only thing that
   * works for a bucket whose name is not DNS-safe.
   */
  _addressing(bucket) {
    const endpoint = this._defaultEndpoint();
    const style = this.session.s3UrlStyle === 'path' ? 'path' : 'virtualhost';
    // A dot in the bucket name breaks TLS certificate matching for
    // virtual-host style, so those buckets always fall back to path style.
    const dnsSafe = bucket && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && !bucket.includes('.');
    if (!bucket) return { host: endpoint, prefix: '' };
    if (style === 'virtualhost' && dnsSafe) return { host: `${bucket}.${endpoint}`, prefix: '' };
    return { host: endpoint, prefix: `/${bucket}` };
  }

  /** '/bucket/a/b.txt' → { bucket: 'bucket', key: 'a/b.txt' }. */
  _split(p) {
    const norm = this.normalize(p);
    if (norm === '/') return { bucket: '', key: '' };
    const parts = norm.slice(1).split('/');
    return { bucket: parts[0], key: parts.slice(1).join('/') };
  }

  // -- TLS + HTTP ----------------------------------------------------------

  async _verifyCertificate(host, port) {
    if (!this.secure || !this.options.certVerifier) return;
    const socket = await new Promise((res, rej) => {
      // SNI must be omitted for an IP literal; TLS has no name to send.
      const s = tls.connect({
        host, port, servername: isIpLiteral(host) ? undefined : host, rejectUnauthorized: false,
      }, () => res(s));
      s.once('error', rej);
    });
    const cert = socket.getPeerCertificate(true);
    const authorized = socket.authorized === true;
    const problem = authorized ? null : String(socket.authorizationError || 'certificate not trusted');
    socket.destroy();
    const summary = {
      subject: cert.subject, issuer: cert.issuer, valid_from: cert.valid_from,
      valid_to: cert.valid_to, fingerprint: cert.fingerprint,
      fingerprint256: cert.fingerprint256, subjectaltname: cert.subjectaltname,
      authorized, problem,
    };
    this.serverInfo.certificate = summary;
    const accepted = await this.options.certVerifier(host, summary, problem);
    if (!accepted) throw new Error(`TLS certificate rejected for ${host}: ${problem || 'not accepted'}`);
    if (!authorized) this._pinned = cert.fingerprint256;
  }

  _makeAgent() {
    const common = { keepAlive: true, maxSockets: 16 };
    this._agent = this.secure
      // Verification stays on unless the user explicitly accepted a certificate
      // that failed the chain check, in which case `_pinCheck` compares against
      // that exact certificate instead.
      ? new https.Agent({ ...common, rejectUnauthorized: !this._pinned })
      : new http.Agent(common);
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

  /**
   * Sign and send one request. Returns `{ status, headers, body }`, or
   * `{ status, headers, stream }` when the caller wants the payload streamed.
   */
  async _httpSigned(spec) {
    await this._ensureCredentials();
    const {
      method, host, port, secure, service = 's3', region, path: uriPath = '/',
      query, headers = {}, body = null, payloadHash, stream, streamBody, signal,
    } = spec;

    const date = new Date();
    const outHeaders = {
      ...headers,
      host: (secure ? port !== 443 : port !== 80) ? `${host}:${port}` : host,
      'x-amz-date': amzDate(date),
      'x-amz-content-sha256': payloadHash || (body ? sha256hex(body) : EMPTY_SHA256),
    };
    if (this.session.s3RequesterPays) outHeaders['x-amz-request-payer'] = 'requester';
    if (body) outHeaders['content-length'] = String(body.length);

    const signed = signRequestV4({
      method,
      path: uriPath,
      query,
      headers: outHeaders,
      body,
      payloadHash: outHeaders['x-amz-content-sha256'],
      service,
      region: region || this.region,
      accessKeyId: this.credentials.accessKeyId,
      secretAccessKey: this.credentials.secretAccessKey,
      sessionToken: this.credentials.sessionToken,
      date,
    });

    const qs = canonicalQuery(query);
    const fullPath = uriEncode(uriPath || '/', false) + (qs ? `?${qs}` : '');
    const lib = secure ? https : http;

    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(new Error('S3 request cancelled')); return; }
      const req = lib.request({
        method,
        hostname: host,
        port,
        path: fullPath,
        headers: signed.headers,
        agent: host === this._agentHost ? this._agent : undefined,
        servername: secure && !isIpLiteral(host) ? host : undefined,
        timeout: Math.max(1, Number(this.session.timeout || 15)) * 1000,
      }, (res) => {
        if (stream && res.statusCode < 300) {
          resolve({ status: res.statusCode, headers: res.headers, stream: res });
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      const abort = () => req.destroy(new Error('S3 request cancelled'));
      if (signal) signal.addEventListener('abort', abort, { once: true });
      req.once('close', () => signal && signal.removeEventListener('abort', abort));
      this._pinCheck(req);
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`Timed out on ${method} ${host}${uriPath}`)));
      if (streamBody) { streamBody(req); return; }
      if (body) req.write(body);
      req.end();
    });
  }

  /** Turn an S3 error document into a message a person can act on. */
  _explain(text, status) {
    if (!text) return `HTTP ${status}`;
    const doc = parseXml(text);
    const err = kid(doc, 'Error') || doc;
    const code = textOf(err, 'Code');
    const message = textOf(err, 'Message');
    if (!code && !message) return `HTTP ${status}: ${String(text).slice(0, 200)}`;
    const extra = textOf(err, 'Region') ? ` (region ${textOf(err, 'Region')})` : '';
    return `${code || `HTTP ${status}`}: ${message}${extra}`;
  }

  /**
   * A signed S3 request against a bucket, with the two retries that matter:
   * the wrong-region redirect S3 answers with, and re-signing after it.
   */
  async _s3(method, bucket, key, opts = {}) {
    const { host, prefix } = this._addressing(bucket);
    this._agentHost = host;
    const uriPath = `${prefix}/${key ? key.split('/').map((s) => uriEncode(s)).join('/') : ''}`;
    // uriEncode is applied per segment above, then `_httpSigned` encodes the
    // path again for the canonical request — so hand it the *decoded* path and
    // let it do the single encoding S3 signs.
    const decodedPath = `${prefix}/${key || ''}`;

    let region = this._bucketRegions.get(bucket) || this.region;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this._httpSigned({
        method,
        host,
        port: this.port,
        secure: this.secure,
        region,
        path: decodedPath,
        query: opts.query,
        headers: opts.headers,
        body: opts.body,
        payloadHash: opts.payloadHash,
        stream: opts.stream,
        streamBody: opts.streamBody,
        signal: opts.signal,
      });

      // S3 answers a misrouted request with the right region in a header; use
      // it and retry rather than making the user guess.
      const hinted = res.headers['x-amz-bucket-region'];
      if (res.status >= 300 && hinted && hinted !== region && attempt === 0) {
        this._bucketRegions.set(bucket, hinted);
        region = hinted;
        continue;
      }
      if (res.status >= 400) {
        const text = res.body ? res.body.toString('utf8') : '';
        const err = new Error(`${method} ${uriPath} — ${this._explain(text, res.status)}`);
        err.status = res.status;
        err.code = /<Code>([^<]+)</.exec(text) ? /<Code>([^<]+)</.exec(text)[1] : '';
        throw err;
      }
      if (bucket) this._bucketRegions.set(bucket, region);
      return res;
    }
    throw new Error('unreachable');
  }

  // -- lifecycle -----------------------------------------------------------

  async connect() {
    await this._resolveCredentials();
    const endpoint = this._defaultEndpoint();
    if (!this.secure) {
      // Running unencrypted is legitimate for a MinIO box on a private network
      // and is what the Encryption setting is for, but it must never be a
      // silent choice: the request line, the object keys and the access key id
      // all go out in the clear.
      this._log('warning', `Connecting to ${endpoint}:${this.port} without encryption; `
        + 'requests and object names travel in the clear');
    }
    await this._verifyCertificate(endpoint, this.port);
    this._makeAgent();
    this._agentHost = endpoint;

    // Listing buckets proves the credentials and gives us the root directory
    // in one call. A user restricted to one bucket cannot do it, which is
    // normal and must not fail the connection.
    try {
      const buckets = await this._listBuckets();
      this.serverInfo.buckets = buckets.length;
    } catch (e) {
      this._log('warning', `Could not list buckets (${e.message}); the account may be scoped to a single bucket`);
    }

    this.home = this.session.remoteDirectory || '/';
    this.connected = true;
    return { home: this.home, region: this.region, endpoint };
  }

  async disconnect() {
    this.connected = false;
    if (this._agent && this._agent.destroy) this._agent.destroy();
    this._agent = null;
    // Drop the secret material as soon as the session ends.
    this.credentials = null;
  }

  // -- listing -------------------------------------------------------------

  async _listBuckets() {
    const res = await this._s3('GET', '', '');
    const doc = parseXml(res.body.toString('utf8'));
    const result = kid(doc, 'ListAllMyBucketsResult');
    const list = kid(result, 'Buckets');
    return kids(list, 'Bucket').map((b) => ({
      name: textOf(b, 'Name'),
      created: Date.parse(textOf(b, 'CreationDate')) || 0,
    }));
  }

  _maxKeys() {
    const v = this.session.s3MaxKeys;
    if (v === undefined || v === null || v === '' || v === 'auto') return null;
    const n = Number(v);
    // S3's max-keys parameter is an integer.  Passing a fractional value is
    // rejected by AWS and several compatible endpoints instead of rounding it.
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) || 1 : null;
  }

  /**
   * One page-following ListObjectsV2 walk.
   *
   * With a delimiter, common prefixes come back as folders; without one, every
   * key under the prefix does — which is what the recursive operations need.
   */
  async _listObjects(bucket, prefix, { delimiter = '/', onPage } = {}) {
    const contents = [];
    const prefixes = [];
    let token = null;
    let previousToken = null;
    const maxKeys = this._maxKeys();

    do {
      const query = { 'list-type': '2' };
      if (prefix) query.prefix = prefix;
      if (delimiter) query.delimiter = delimiter;
      if (maxKeys) query['max-keys'] = String(maxKeys);
      if (token) query['continuation-token'] = token;

      const res = await this._s3('GET', bucket, '', { query });
      const doc = parseXml(res.body.toString('utf8'));
      const result = kid(doc, 'ListBucketResult');
      if (!result) break;

      const page = kids(result, 'Contents').map((c) => ({
        key: textOf(c, 'Key'),
        size: Number(textOf(c, 'Size')) || 0,
        mtime: Date.parse(textOf(c, 'LastModified')) || 0,
        etag: textOf(c, 'ETag').replace(/^"|"$/g, ''),
        storageClass: textOf(c, 'StorageClass'),
      }));
      contents.push(...page);
      for (const cp of kids(result, 'CommonPrefixes')) prefixes.push(textOf(cp, 'Prefix'));
      if (onPage) onPage(page);

      token = textOf(result, 'IsTruncated') === 'true' ? textOf(result, 'NextContinuationToken') : null;
      // A truncated listing with no token would loop forever; some
      // S3-compatible servers get this wrong, so stop rather than spin.
      if (textOf(result, 'IsTruncated') === 'true' && !token) {
        this._log('warning', 'Server reported a truncated listing but returned no continuation token');
        break;
      }
      if (token && token === previousToken) {
        this._log('warning', 'Server repeated a continuation token; stopping the listing to avoid a loop');
        break;
      }
      previousToken = token;
    } while (token);

    return { contents, prefixes };
  }

  async list(dir) {
    const { bucket, key } = this._split(dir || this.home);

    if (!bucket) {
      const buckets = await this._listBuckets();
      return buckets.map((b) => entry({ name: b.name, type: 'dir', mtime: b.created }));
    }

    const prefix = key ? `${key.replace(/\/+$/, '')}/` : '';
    const { contents, prefixes } = await this._listObjects(bucket, prefix);

    const out = prefixes.map((p) => entry({
      name: p.slice(prefix.length).replace(/\/$/, ''),
      type: 'dir',
      raw: { prefix: p },
    }));

    for (const c of contents) {
      // The zero-byte key that *is* this folder is the folder marker; showing
      // it as a file would be a lie about what is in the bucket.
      if (c.key === prefix) continue;
      const name = c.key.slice(prefix.length);
      if (!name) continue;
      // A marker for a sub-folder that produced no common prefix (possible
      // when a delimiter is not honoured) is still a folder.
      if (name.endsWith('/')) {
        const folder = name.replace(/\/$/, '');
        if (folder && !out.some((e) => e.name === folder)) {
          out.push(entry({ name: folder, type: 'dir', mtime: c.mtime, raw: { marker: c.key } }));
        }
        continue;
      }
      out.push(entry({
        name,
        type: 'file',
        size: c.size,
        mtime: c.mtime,
        raw: { key: c.key, etag: c.etag, storageClass: c.storageClass },
      }));
    }
    return out;
  }

  async stat(p) {
    const { bucket, key } = this._split(p);
    if (!bucket) return entry({ name: '/', type: 'dir' });
    if (!key) {
      // A bucket exists if we can reach it at all.
      await this._s3('HEAD', bucket, '');
      return entry({ name: bucket, type: 'dir' });
    }

    try {
      const res = await this._s3('HEAD', bucket, key);
      return entry({
        name: this.basename(p),
        type: 'file',
        size: Number(res.headers['content-length']) || 0,
        mtime: Date.parse(res.headers['last-modified']) || 0,
        raw: {
          etag: String(res.headers.etag || '').replace(/^"|"$/g, ''),
          storageClass: res.headers['x-amz-storage-class'] || '',
          contentType: res.headers['content-type'] || '',
        },
      });
    } catch (e) {
      if (e.status !== 404) throw e;
    }

    // Not an object — but it may still be a prefix with things under it, which
    // is what a "folder" is in S3.
    const prefix = `${key.replace(/\/+$/, '')}/`;
    const { contents, prefixes } = await this._listObjects(bucket, prefix);
    if (contents.length || prefixes.length) return entry({ name: this.basename(p), type: 'dir' });
    throw Object.assign(new Error(`No such key: ${p}`), { status: 404 });
  }

  // -- writing -------------------------------------------------------------

  async mkdir(p) {
    const { bucket, key } = this._split(p);
    if (!bucket) throw new Error('Cannot create a directory at the service root');
    if (!key) {
      // The path is a bucket name: create the bucket.
      const body = this.region && this.region !== 'us-east-1'
        ? Buffer.from(`<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${this.region}</LocationConstraint></CreateBucketConfiguration>`, 'utf8')
        : null;
      await this._s3('PUT', bucket, '', { body, headers: body ? { 'content-type': 'application/xml' } : {} });
      return;
    }
    // A folder is a zero-byte key ending in '/', the convention every S3 tool
    // and the AWS console itself uses so that an empty folder can exist.
    await this._s3('PUT', bucket, `${key.replace(/\/+$/, '')}/`, {
      body: Buffer.alloc(0),
      headers: { 'content-length': '0' },
    });
  }

  async remove(p, opts = {}) {
    const { bucket, key } = this._split(p);
    if (!bucket) throw new Error('Cannot delete the service root');
    if (!key) {
      if (opts.recursive) await this._deletePrefix(bucket, '');
      await this._s3('DELETE', bucket, '');
      return;
    }

    const info = await this.stat(p).catch(() => null);
    if (info && info.type === 'dir') {
      await this._deletePrefix(bucket, `${key.replace(/\/+$/, '')}/`);
      // And the marker object itself, if one exists.
      await this._s3('DELETE', bucket, `${key.replace(/\/+$/, '')}/`).catch((error) => {
        // A folder marker can disappear between the listing and this cleanup.
        // WinSCP treats that specific race as harmless, but must still surface
        // permission, transport, and other delete failures.
        if (error && error.status === 404) return;
        throw error;
      });
      return;
    }
    await this._s3('DELETE', bucket, key);
  }

  /** Delete everything under a prefix, 1000 keys at a time. */
  async _deletePrefix(bucket, prefix) {
    const { contents } = await this._listObjects(bucket, prefix, { delimiter: '' });
    for (let i = 0; i < contents.length; i += 1000) {
      await this._deleteObjects(bucket, contents.slice(i, i + 1000).map((c) => c.key));
    }
  }

  async _deleteObjects(bucket, keys) {
    if (!keys.length) return;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${
      keys.map((k) => `<Object><Key>${k.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</Key></Object>`).join('')
    }</Delete>`;
    const body = Buffer.from(xml, 'utf8');
    const res = await this._s3('POST', bucket, '', {
      query: { delete: '' },
      // DeleteObjects is one of the few calls that still requires Content-MD5;
      // without it S3 answers 400 and says nothing useful about why.
      headers: {
        'content-type': 'application/xml',
        'content-md5': crypto.createHash('md5').update(body).digest('base64'),
      },
      body,
    });
    const doc = parseXml(res.body.toString('utf8'));
    const result = kid(doc, 'DeleteResult');
    const errors = kids(result, 'Error');
    if (errors.length) {
      throw new Error(`Could not delete ${errors.length} object(s), first: `
        + `${textOf(errors[0], 'Key')} — ${textOf(errors[0], 'Code')} ${textOf(errors[0], 'Message')}`);
    }
  }

  /**
   * S3 has no rename. A move is a server-side copy followed by a delete, and
   * a "folder" rename is that repeated for every key under the prefix.
   */
  async rename(from, to) {
    const src = this._split(from);
    const dst = this._split(to);
    if (!src.bucket || !dst.bucket) throw new Error('Cannot rename a bucket in place; create a new one and copy');

    const info = await this.stat(from);
    if (info.type === 'dir') {
      const srcPrefix = `${src.key.replace(/\/+$/, '')}/`;
      const dstPrefix = `${dst.key.replace(/\/+$/, '')}/`;
      const { contents } = await this._listObjects(src.bucket, srcPrefix, { delimiter: '' });
      for (const c of contents) {
        const target = dstPrefix + c.key.slice(srcPrefix.length);
        await this._copyObject(src.bucket, c.key, dst.bucket, target, c.size);
      }
      for (let i = 0; i < contents.length; i += 1000) {
        await this._deleteObjects(src.bucket, contents.slice(i, i + 1000).map((c) => c.key));
      }
      return;
    }
    await this._copyObject(src.bucket, src.key, dst.bucket, dst.key, info.size);
    await this._s3('DELETE', src.bucket, src.key);
  }

  /** Server-side duplicate, which is what `caps.copyRemote` promises. */
  async copy(from, to) {
    const src = this._split(from);
    const dst = this._split(to);
    const info = await this.stat(from);
    if (info.type === 'dir') {
      const srcPrefix = `${src.key.replace(/\/+$/, '')}/`;
      const dstPrefix = `${dst.key.replace(/\/+$/, '')}/`;
      const { contents } = await this._listObjects(src.bucket, srcPrefix, { delimiter: '' });
      for (const c of contents) {
        await this._copyObject(src.bucket, c.key, dst.bucket, dstPrefix + c.key.slice(srcPrefix.length), c.size);
      }
      return;
    }
    await this._copyObject(src.bucket, src.key, dst.bucket, dst.key, info.size);
  }

  async _copyObject(srcBucket, srcKey, dstBucket, dstKey, size) {
    const source = `/${srcBucket}/${srcKey.split('/').map((s) => uriEncode(s)).join('/')}`;
    if (!size || size <= MAX_SINGLE_COPY) {
      const headers = { 'x-amz-copy-source': source };
      if (this.session.s3StorageClass) headers['x-amz-storage-class'] = this.session.s3StorageClass;
      await this._s3('PUT', dstBucket, dstKey, { headers });
      return;
    }

    // Beyond 5 GiB the only way across is a multipart copy, part by part.
    const uploadId = await this._createMultipartUpload(dstBucket, dstKey, {});
    try {
      const parts = [];
      // Keep copy parts under S3's 10,000-part limit while preserving the
      // same 5 MiB floor used by streamed uploads.  DEFAULT_PART_SIZE was
      // never defined here, so every real copy above 5 GiB previously failed
      // before the first UploadPartCopy request was sent.
      const partSize = partSizeFor(size);
      let offset = 0;
      let n = 0;
      while (offset < size) {
        const end = Math.min(offset + partSize, size) - 1;
        n += 1;
        const res = await this._s3('PUT', dstBucket, dstKey, {
          query: { partNumber: String(n), uploadId },
          headers: { 'x-amz-copy-source': source, 'x-amz-copy-source-range': `bytes=${offset}-${end}` },
        });
        const doc = parseXml(res.body.toString('utf8'));
        const etag = textOf(kid(doc, 'CopyPartResult'), 'ETag').replace(/^"|"$/g, '');
        parts.push({ partNumber: n, etag });
        offset = end + 1;
      }
      await this._completeMultipartUpload(dstBucket, dstKey, uploadId, parts);
    } catch (e) {
      await this._abortMultipartUpload(dstBucket, dstKey, uploadId).catch(() => {});
      throw e;
    }
  }

  // -- object I/O ----------------------------------------------------------

  async _putObject(bucket, key, body, opts = {}) {
    const headers = { 'content-type': opts.contentType || 'application/octet-stream' };
    if (this.session.s3StorageClass) headers['x-amz-storage-class'] = this.session.s3StorageClass;
    const res = await this._s3('PUT', bucket, key, { body, headers });
    return { etag: String(res.headers.etag || '').replace(/^"|"$/g, '') };
  }

  async _createMultipartUpload(bucket, key, opts = {}) {
    const headers = { 'content-type': opts.contentType || 'application/octet-stream' };
    if (this.session.s3StorageClass) headers['x-amz-storage-class'] = this.session.s3StorageClass;
    const res = await this._s3('POST', bucket, key, { query: { uploads: '' }, headers, body: Buffer.alloc(0) });
    const doc = parseXml(res.body.toString('utf8'));
    const id = textOf(kid(doc, 'InitiateMultipartUploadResult'), 'UploadId');
    if (!id) throw new Error('CreateMultipartUpload returned no UploadId');
    return id;
  }

  async _uploadPart(bucket, key, uploadId, partNumber, body) {
    const res = await this._s3('PUT', bucket, key, {
      query: { partNumber: String(partNumber), uploadId },
      body,
    });
    const etag = String(res.headers.etag || '').replace(/^"|"$/g, '');
    if (!etag) throw new Error(`UploadPart ${partNumber} returned no ETag`);
    return etag;
  }

  async _completeMultipartUpload(bucket, key, uploadId, parts) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${
      parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`).join('')
    }</CompleteMultipartUpload>`;
    const res = await this._s3('POST', bucket, key, {
      query: { uploadId },
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from(xml, 'utf8'),
    });
    const text = res.body.toString('utf8');
    // CompleteMultipartUpload can fail *inside* a 200 response — S3 keeps the
    // connection alive with whitespace while it assembles the object and only
    // then writes the body. Treating 200 as success here loses real failures.
    if (/<Error>/.test(text)) throw new Error(`CompleteMultipartUpload failed — ${this._explain(text, 200)}`);
    const doc = parseXml(text);
    return { etag: textOf(kid(doc, 'CompleteMultipartUploadResult'), 'ETag').replace(/^"|"$/g, '') };
  }

  async _abortMultipartUpload(bucket, key, uploadId) {
    await this._s3('DELETE', bucket, key, { query: { uploadId } });
  }

  async createReadStream(p, opts = {}) {
    const { bucket, key } = this._split(p);
    if (!bucket || !key) throw new Error(`Not a file: ${p}`);
    const start = Number(opts.start || 0);
    const headers = {};
    if (start > 0) headers.range = opts.end ? `bytes=${start}-${opts.end}` : `bytes=${start}-`;

    const res = await this._s3('GET', bucket, key, { headers, stream: true, signal: opts.signal });
    if (start > 0 && res.status !== 206) {
      if (res.stream) res.stream.destroy();
      throw new Error(`Server ignored the Range header (answered ${res.status}); resume is not possible`);
    }
    const out = new PassThrough();
    if (opts.signal) {
      const abort = () => out.destroy(new Error('S3 download cancelled'));
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener('abort', abort, { once: true });
    }
    res.stream.pipe(out);
    res.stream.on('error', (e) => out.destroy(e));
    return out;
  }

  async createWriteStream(p, opts = {}) {
    const { bucket, key } = this._split(p);
    if (!bucket || !key) throw new Error(`Not a file: ${p}`);
    return new S3UploadStream(this, bucket, key, opts);
  }

  /**
   * The ETag is an MD5 for anything uploaded in one piece, and
   * `<md5>-<parts>` for a multipart object — which is not an MD5 of anything
   * and must not be presented as one.
   */
  async checksum(p, algorithm = 'md5') {
    const requested = String(algorithm).toLowerCase();
    if (requested !== 'md5') {
      throw new Error(`S3 checksum does not support ${algorithm}; only md5 is available from single-part ETags`);
    }
    const info = await this.stat(p);
    const etag = info.raw && info.raw.etag ? info.raw.etag : '';
    if (!etag || etag.includes('-')) {
      throw new Error('This object was uploaded in parts; its ETag is not an MD5 of the content');
    }
    return etag;
  }
}

module.exports = {
  S3Adapter,
  S3UploadStream,
  signRequestV4,
  createCanonicalRequest,
  createStringToSign,
  deriveSigningKey,
  canonicalQuery,
  canonicalHeaders,
  uriEncode,
  amzDate,
  sha256hex,
  parseXml,
  parseAwsIni,
  readAwsProfile,
  EMPTY_SHA256,
};
