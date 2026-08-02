// s3-server.js — a REAL S3-compatible server on node:http.
//
// The point of this file is the signature check. `test/protocols-s3sig.test.js`
// already proves our SigV4 matches AWS's published vectors, but a published
// vector is a fixed string: it cannot tell you that the path we *sent* is the
// path we *signed*, that a query string arrived in the order it was signed in,
// or that a header we added after signing quietly invalidated it. This server
// recomputes the whole canonical request from the bytes that actually arrived
// and answers 403 SignatureDoesNotMatch when it disagrees — which is the only
// way to turn "our signing function is right" into "our signing works".
//
// It also enforces the S3 rules that bite in production rather than in a
// vector: a non-final multipart part below 5 MiB is rejected exactly as S3
// rejects it, DeleteObjects requires Content-MD5, ListObjectsV2 pages with a
// continuation token, and a delimiter groups keys into common prefixes.
//
// Storage is in memory. Bytes are compared byte-for-byte, never by ETag alone.
'use strict';

const http = require('http');
const crypto = require('crypto');

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const ALGORITHM = 'AWS4-HMAC-SHA256';
const MIN_PART_SIZE = 5 * 1024 * 1024;

function sha256hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function md5hex(data) { return crypto.createHash('md5').update(data).digest('hex'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data, 'utf8').digest(); }

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
function xmlEscape(s) { return String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]); }

function deriveSigningKey(secret, dateStamp, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
}

/** Decode a percent-encoded path, segment by segment, leaving '/' alone. */
function decodePath(p) {
  return p.split('/').map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  }).join('/');
}

/**
 * Rebuild the canonical query string from the raw query as it arrived.
 *
 * The raw pieces are used rather than a decode/re-encode round trip so that a
 * client whose encoding differs from ours is caught instead of accidentally
 * normalized into agreement.
 */
function canonicalQueryFromRaw(rawQuery) {
  if (!rawQuery) return '';
  return rawQuery.split('&').filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq < 0 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function parseAuthorization(header) {
  const m = /^AWS4-HMAC-SHA256\s+(.*)$/.exec(String(header || ''));
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (!out.Credential || !out.SignedHeaders || !out.Signature) return null;
  const [accessKeyId, dateStamp, region, service, terminator] = out.Credential.split('/');
  return {
    accessKeyId,
    dateStamp,
    region,
    service,
    terminator,
    signedHeaders: out.SignedHeaders.split(';'),
    signature: out.Signature,
  };
}

function queryOf(url) {
  const q = url.indexOf('?');
  return q < 0 ? '' : url.slice(q + 1);
}

function queryParams(rawQuery) {
  const out = {};
  for (const pair of String(rawQuery || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

/** Pull every <Key> out of a DeleteObjects body without a real XML parser. */
function keysFromDeleteBody(text) {
  const out = [];
  const re = /<Key>([\s\S]*?)<\/Key>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'));
  }
  return out;
}

function partsFromCompleteBody(text) {
  const out = [];
  const re = /<Part>([\s\S]*?)<\/Part>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = /<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(m[1]);
    const e = /<ETag>\s*"?([^"<]+)"?\s*<\/ETag>/.exec(m[1]);
    if (n) out.push({ partNumber: Number(n[1]), etag: e ? e[1] : '' });
  }
  return out;
}

/**
 * Start the server.
 *
 * @param options.accessKeyId      credential the server will accept
 * @param options.secretAccessKey  secret the server signs with (never logged)
 * @param options.region           credential-scope region
 * @param options.buckets          bucket names to pre-create
 * @param options.pageSize         maximum items per ListObjectsV2 page
 * @returns a handle with `port`, `origin`, `requests`, `buckets`, `uploads`,
 *          `failPart`, and `close()`
 */
async function startS3Server(options = {}) {
  const accessKeyId = options.accessKeyId || 'AKIAIOSFODNN7EXAMPLE';
  const secretAccessKey = options.secretAccessKey || 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const region = options.region || 'us-east-1';
  const defaultPageSize = options.pageSize || 1000;

  const buckets = new Map();
  const uploads = new Map();
  const requests = [];
  const sockets = new Set();
  /** Fault injection: which UploadPart number should fail (null = none). */
  const faults = { failPart: null, failPartUploads: new Set() };

  for (const name of options.buckets || []) {
    buckets.set(name, { created: Date.now(), objects: new Map() });
  }

  let uploadCounter = 0;

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const sendXml = (res, status, xml, headers = {}) => {
    const buf = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`, 'utf8');
    res.writeHead(status, { 'Content-Type': 'application/xml', 'Content-Length': String(buf.length), ...headers });
    res.end(buf);
  };

  const sendError = (res, status, code, message, extra = '') => {
    sendXml(res, status,
      `<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message>${extra}`
      + '<RequestId>winscp-material-test</RequestId></Error>');
  };

  // -- SigV4 verification ---------------------------------------------------

  /** @returns null when the signature verifies, or [code, message] when not. */
  function verifySignature(req, rawPath, rawQuery, body) {
    const parsed = parseAuthorization(req.headers.authorization);
    if (!parsed) return ['AccessDenied', 'Missing or malformed Authorization header'];
    if (parsed.accessKeyId !== accessKeyId) {
      return ['InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.'];
    }
    if (parsed.service !== 's3' || parsed.terminator !== 'aws4_request') {
      return ['AuthorizationQueryParametersError', 'Bad credential scope'];
    }
    if (parsed.region !== region) {
      return ['AuthorizationHeaderMalformed', `The authorization header is malformed; the region '${parsed.region}' is wrong; expecting '${region}'`];
    }

    const amzDate = req.headers['x-amz-date'];
    if (!amzDate || amzDate.slice(0, 8) !== parsed.dateStamp) {
      return ['AuthorizationHeaderMalformed', 'x-amz-date does not match the credential scope date'];
    }

    const declaredHash = req.headers['x-amz-content-sha256'];
    if (!declaredHash) return ['InvalidRequest', 'Missing x-amz-content-sha256'];
    // Verify the payload really is what was signed. A client that signs one
    // body and sends another passes a vector test and fails here.
    if (/^[0-9a-f]{64}$/.test(declaredHash) && sha256hex(body) !== declaredHash) {
      return ['XAmzContentSHA256Mismatch',
        'The provided x-amz-content-sha256 header does not match what was computed.'];
    }

    // The canonical headers are built only from SignedHeaders, so a header the
    // client left out of the signature is a header the check cannot notice.
    // Real S3 refuses a request that does not sign `host` and the `x-amz-*`
    // headers it sent, precisely so those cannot be tampered with in flight —
    // without this, an adapter that signed nothing but the date would verify.
    for (const required of ['host', 'x-amz-content-sha256', 'x-amz-date']) {
      if (!parsed.signedHeaders.includes(required)) {
        return ['AuthorizationHeaderMalformed', `SignedHeaders must include '${required}'`];
      }
    }
    for (const name of Object.keys(req.headers)) {
      if (name.startsWith('x-amz-') && !parsed.signedHeaders.includes(name)) {
        return ['AuthorizationHeaderMalformed',
          `The '${name}' header was sent but not signed`];
      }
    }

    const canonicalHeaders = parsed.signedHeaders
      .map((name) => {
        const value = name === 'host' ? req.headers.host : req.headers[name];
        if (value === undefined) return null;
        return `${name}:${String(value).trim().replace(/\s+/g, ' ')}\n`;
      });
    if (canonicalHeaders.some((h) => h === null)) {
      return ['SignatureDoesNotMatch', 'A signed header was not present in the request'];
    }

    const canonicalRequest = [
      req.method,
      rawPath || '/',
      canonicalQueryFromRaw(rawQuery),
      canonicalHeaders.join(''),
      parsed.signedHeaders.join(';'),
      declaredHash,
    ].join('\n');

    const scope = `${parsed.dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const key = deriveSigningKey(secretAccessKey, parsed.dateStamp, region, 's3');
    const expected = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

    if (expected !== parsed.signature) {
      return ['SignatureDoesNotMatch',
        'The request signature we calculated does not match the signature you provided. '
        + 'Check your key and signing method.'];
    }
    return null;
  }

  // -- listing --------------------------------------------------------------

  function listObjects(bucket, params) {
    const prefix = params.prefix || '';
    const delimiter = params.delimiter || '';
    const requested = params['max-keys'] ? Number(params['max-keys']) : 1000;
    const limit = Math.max(1, Math.min(requested || 1000, defaultPageSize));

    const keys = [...bucket.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const items = [];
    const seenPrefixes = new Set();
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const cut = delimiter ? rest.indexOf(delimiter) : -1;
      if (cut >= 0) {
        const cp = prefix + rest.slice(0, cut + delimiter.length);
        if (!seenPrefixes.has(cp)) { seenPrefixes.add(cp); items.push({ type: 'prefix', name: cp }); }
      } else {
        items.push({ type: 'key', name: key });
      }
    }
    // Real S3 returns prefixes and keys interleaved in overall sorted order and
    // counts them together against max-keys, which is what makes paging with a
    // delimiter subtle enough to be worth testing.
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    let start = 0;
    if (params['continuation-token']) {
      const after = Buffer.from(params['continuation-token'], 'base64').toString('utf8');
      start = items.findIndex((i) => i.name > after);
      if (start < 0) start = items.length;
    }
    const page = items.slice(start, start + limit);
    const truncated = start + limit < items.length;
    return {
      page,
      truncated,
      nextToken: truncated && page.length
        ? Buffer.from(page[page.length - 1].name, 'utf8').toString('base64') : '',
      prefix,
      delimiter,
      maxKeys: limit,
    };
  }

  // -- request handling -----------------------------------------------------

  const server = http.createServer(async (req, res) => {
    const rawPath = req.url.split('?')[0];
    const rawQuery = queryOf(req.url);
    const params = queryParams(rawQuery);
    let body;
    try { body = await readBody(req); } catch { res.destroy(); return; }

    requests.push({
      method: req.method, path: rawPath, query: params, headers: { ...req.headers },
    });

    const bad = verifySignature(req, rawPath, rawQuery, body);
    if (bad) { sendError(res, 403, bad[0], bad[1]); return; }

    try {
      await handle(req, res, rawPath, params, body);
    } catch (err) {
      if (!res.headersSent) sendError(res, 500, 'InternalError', err.message);
      else res.destroy();
    }
  });

  async function handle(req, res, rawPath, params, body) {
    const decoded = decodePath(rawPath);
    const withoutLeading = decoded.replace(/^\//, '');
    const slash = withoutLeading.indexOf('/');
    const bucketName = slash < 0 ? withoutLeading : withoutLeading.slice(0, slash);
    const key = slash < 0 ? '' : withoutLeading.slice(slash + 1);
    const method = req.method.toUpperCase();

    // ---- service level ----------------------------------------------------
    if (!bucketName) {
      if (method !== 'GET') { sendError(res, 405, 'MethodNotAllowed', 'Only GET is allowed on the service root'); return; }
      const list = [...buckets.entries()].map(([name, b]) => `<Bucket><Name>${xmlEscape(name)}</Name>`
        + `<CreationDate>${new Date(b.created).toISOString()}</CreationDate></Bucket>`).join('');
      sendXml(res, 200, '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        + `<Owner><ID>winscp-material</ID><DisplayName>test</DisplayName></Owner><Buckets>${list}</Buckets>`
        + '</ListAllMyBucketsResult>');
      return;
    }

    // ---- bucket level -----------------------------------------------------
    if (!key) {
      if (method === 'PUT') {
        if (buckets.has(bucketName)) { sendError(res, 409, 'BucketAlreadyOwnedByYou', 'You already own this bucket.'); return; }
        buckets.set(bucketName, { created: Date.now(), objects: new Map() });
        res.writeHead(200, { Location: `/${bucketName}`, 'Content-Length': '0' });
        res.end();
        return;
      }
      const bucket = buckets.get(bucketName);
      if (!bucket) { sendError(res, 404, 'NoSuchBucket', 'The specified bucket does not exist'); return; }

      if (method === 'HEAD') { res.writeHead(200, { 'Content-Length': '0' }); res.end(); return; }

      if (method === 'DELETE') {
        if (bucket.objects.size) { sendError(res, 409, 'BucketNotEmpty', 'The bucket you tried to delete is not empty'); return; }
        buckets.delete(bucketName);
        res.writeHead(204); res.end();
        return;
      }

      if (method === 'POST' && 'delete' in params) {
        // DeleteObjects. S3 still requires Content-MD5 here, and answers 400
        // with nothing useful when it is missing — so check it for real.
        const md5 = req.headers['content-md5'];
        if (!md5) { sendError(res, 400, 'MissingContentMD5', 'Missing required header for this request: Content-MD5'); return; }
        if (crypto.createHash('md5').update(body).digest('base64') !== md5) {
          sendError(res, 400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.');
          return;
        }
        const text = body.toString('utf8');
        const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(text);
        const deleted = [];
        const errors = [];
        for (const k of keysFromDeleteBody(text)) {
          if (bucket.objects.delete(k)) deleted.push(k);
          else deleted.push(k);   // S3 reports a missing key as deleted
        }
        const body2 = quiet ? '' : deleted.map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`).join('');
        sendXml(res, 200, `<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body2}${errors.join('')}</DeleteResult>`);
        return;
      }

      if (method === 'GET') {
        if (params['list-type'] !== '2') { sendError(res, 400, 'InvalidArgument', 'Only ListObjectsV2 is implemented'); return; }
        const r = listObjects(bucket, params);
        const contents = r.page.filter((i) => i.type === 'key').map((i) => {
          const o = bucket.objects.get(i.name);
          return `<Contents><Key>${xmlEscape(i.name)}</Key>`
            + `<LastModified>${new Date(o.lastModified).toISOString()}</LastModified>`
            + `<ETag>&quot;${o.etag}&quot;</ETag><Size>${o.body.length}</Size>`
            + `<StorageClass>${o.storageClass || 'STANDARD'}</StorageClass></Contents>`;
        }).join('');
        const prefixes = r.page.filter((i) => i.type === 'prefix')
          .map((i) => `<CommonPrefixes><Prefix>${xmlEscape(i.name)}</Prefix></CommonPrefixes>`).join('');
        sendXml(res, 200, '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
          + `<Name>${xmlEscape(bucketName)}</Name><Prefix>${xmlEscape(r.prefix)}</Prefix>`
          + `<KeyCount>${r.page.length}</KeyCount><MaxKeys>${r.maxKeys}</MaxKeys>`
          + (r.delimiter ? `<Delimiter>${xmlEscape(r.delimiter)}</Delimiter>` : '')
          + `<IsTruncated>${r.truncated ? 'true' : 'false'}</IsTruncated>`
          + (r.nextToken ? `<NextContinuationToken>${r.nextToken}</NextContinuationToken>` : '')
          + (params['continuation-token'] ? `<ContinuationToken>${xmlEscape(params['continuation-token'])}</ContinuationToken>` : '')
          + contents + prefixes
          + '</ListBucketResult>');
        return;
      }

      sendError(res, 405, 'MethodNotAllowed', `${method} is not allowed on a bucket`);
      return;
    }

    // ---- object level -----------------------------------------------------
    const bucket = buckets.get(bucketName);
    if (!bucket) { sendError(res, 404, 'NoSuchBucket', 'The specified bucket does not exist'); return; }

    // Multipart: create
    if (method === 'POST' && 'uploads' in params) {
      uploadCounter += 1;
      const uploadId = `upload-${uploadCounter}-${crypto.randomBytes(6).toString('hex')}`;
      uploads.set(uploadId, {
        bucket: bucketName,
        key,
        parts: new Map(),
        contentType: req.headers['content-type'] || 'application/octet-stream',
        storageClass: req.headers['x-amz-storage-class'] || 'STANDARD',
      });
      sendXml(res, 200, '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        + `<Bucket>${xmlEscape(bucketName)}</Bucket><Key>${xmlEscape(key)}</Key>`
        + `<UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }

    // Multipart: complete
    if (method === 'POST' && params.uploadId) {
      const up = uploads.get(params.uploadId);
      if (!up) { sendError(res, 404, 'NoSuchUpload', 'The specified upload does not exist.'); return; }
      const wanted = partsFromCompleteBody(body.toString('utf8'));
      if (!wanted.length) { sendError(res, 400, 'MalformedXML', 'The XML you provided was not well-formed'); return; }

      const buffers = [];
      for (let i = 0; i < wanted.length; i++) {
        const part = up.parts.get(wanted[i].partNumber);
        if (!part) { sendError(res, 400, 'InvalidPart', `Part ${wanted[i].partNumber} was never uploaded`); return; }
        if (part.etag !== wanted[i].etag) {
          sendError(res, 400, 'InvalidPart', `Part ${wanted[i].partNumber} ETag does not match`);
          return;
        }
        // S3's real rule: every part except the last must be at least 5 MiB.
        if (i < wanted.length - 1 && part.body.length < MIN_PART_SIZE) {
          sendError(res, 400, 'EntityTooSmall',
            'Your proposed upload is smaller than the minimum allowed size',
            `<PartNumber>${wanted[i].partNumber}</PartNumber><MinSizeAllowed>${MIN_PART_SIZE}</MinSizeAllowed>`);
          return;
        }
        buffers.push(part.body);
      }
      const assembled = Buffer.concat(buffers);
      const etag = `${md5hex(Buffer.concat(wanted.map((w) => Buffer.from(up.parts.get(w.partNumber).etag, 'hex'))))}-${wanted.length}`;
      bucket.objects.set(up.key, {
        body: assembled,
        contentType: up.contentType,
        storageClass: up.storageClass,
        lastModified: Date.now(),
        etag,
      });
      uploads.delete(params.uploadId);
      sendXml(res, 200, '<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        + `<Location>/${xmlEscape(bucketName)}/${xmlEscape(up.key)}</Location>`
        + `<Bucket>${xmlEscape(bucketName)}</Bucket><Key>${xmlEscape(up.key)}</Key>`
        + `<ETag>&quot;${etag}&quot;</ETag></CompleteMultipartUploadResult>`);
      return;
    }

    // Multipart: abort
    if (method === 'DELETE' && params.uploadId) {
      const up = uploads.get(params.uploadId);
      if (!up) { sendError(res, 404, 'NoSuchUpload', 'The specified upload does not exist.'); return; }
      uploads.delete(params.uploadId);
      res.writeHead(204); res.end();
      return;
    }

    // Multipart: upload part (and the ranged copy variant)
    if (method === 'PUT' && params.uploadId && params.partNumber) {
      const up = uploads.get(params.uploadId);
      if (!up) { sendError(res, 404, 'NoSuchUpload', 'The specified upload does not exist.'); return; }
      const n = Number(params.partNumber);
      if (faults.failPart === n) {
        faults.failPartUploads.add(params.uploadId);
        sendError(res, 500, 'InternalError', `Injected failure for part ${n}`);
        return;
      }

      const copySource = req.headers['x-amz-copy-source'];
      if (copySource) {
        const src = resolveCopySource(copySource);
        if (!src) { sendError(res, 404, 'NoSuchKey', 'The specified copy source does not exist'); return; }
        const rangeMatch = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers['x-amz-copy-source-range'] || ''));
        const slice = rangeMatch
          ? src.body.subarray(Number(rangeMatch[1]), Number(rangeMatch[2]) + 1)
          : src.body;
        const etag = md5hex(slice);
        up.parts.set(n, { body: Buffer.from(slice), etag });
        sendXml(res, 200, `<CopyPartResult><ETag>&quot;${etag}&quot;</ETag>`
          + `<LastModified>${new Date().toISOString()}</LastModified></CopyPartResult>`);
        return;
      }

      const etag = md5hex(body);
      up.parts.set(n, { body, etag });
      res.writeHead(200, { ETag: `"${etag}"`, 'Content-Length': '0' });
      res.end();
      return;
    }

    if (method === 'PUT') {
      const copySource = req.headers['x-amz-copy-source'];
      if (copySource) {
        const src = resolveCopySource(copySource);
        if (!src) { sendError(res, 404, 'NoSuchKey', 'The specified copy source does not exist'); return; }
        const now = Date.now();
        bucket.objects.set(key, {
          body: Buffer.from(src.body),
          contentType: src.contentType,
          storageClass: req.headers['x-amz-storage-class'] || src.storageClass,
          lastModified: now,
          etag: src.etag,
        });
        sendXml(res, 200, `<CopyObjectResult><LastModified>${new Date(now).toISOString()}</LastModified>`
          + `<ETag>&quot;${src.etag}&quot;</ETag></CopyObjectResult>`);
        return;
      }
      const etag = md5hex(body);
      bucket.objects.set(key, {
        body,
        contentType: req.headers['content-type'] || 'application/octet-stream',
        storageClass: req.headers['x-amz-storage-class'] || 'STANDARD',
        lastModified: Date.now(),
        etag,
      });
      res.writeHead(200, { ETag: `"${etag}"`, 'Content-Length': '0' });
      res.end();
      return;
    }

    const object = bucket.objects.get(key);
    if (method === 'HEAD') {
      if (!object) { res.writeHead(404, { 'Content-Length': '0' }); res.end(); return; }
      res.writeHead(200, {
        'Content-Length': String(object.body.length),
        'Content-Type': object.contentType,
        ETag: `"${object.etag}"`,
        'Last-Modified': new Date(object.lastModified).toUTCString(),
        'x-amz-storage-class': object.storageClass,
        'Accept-Ranges': 'bytes',
      });
      res.end();
      return;
    }

    if (method === 'GET') {
      if (!object) { sendError(res, 404, 'NoSuchKey', 'The specified key does not exist.'); return; }
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      if (range) {
        const size = object.body.length;
        const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        const end = range[1] === '' ? size - 1
          : (range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1));
        if (start >= size || start > end) {
          sendError(res, 416, 'InvalidRange', 'The requested range is not satisfiable');
          return;
        }
        const slice = object.body.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Length': String(slice.length),
          'Content-Type': object.contentType,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          ETag: `"${object.etag}"`,
          'Last-Modified': new Date(object.lastModified).toUTCString(),
          'Accept-Ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        'Content-Length': String(object.body.length),
        'Content-Type': object.contentType,
        ETag: `"${object.etag}"`,
        'Last-Modified': new Date(object.lastModified).toUTCString(),
        'Accept-Ranges': 'bytes',
      });
      res.end(object.body);
      return;
    }

    if (method === 'DELETE') {
      bucket.objects.delete(key);
      res.writeHead(204); res.end();
      return;
    }

    sendError(res, 405, 'MethodNotAllowed', `${method} is not allowed on an object`);
  }

  function resolveCopySource(header) {
    const raw = String(header).replace(/^\//, '');
    const decoded = decodePath(raw);
    const slash = decoded.indexOf('/');
    if (slash < 0) return null;
    const b = buckets.get(decoded.slice(0, slash));
    return b ? b.objects.get(decoded.slice(slash + 1)) || null : null;
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    accessKeyId,
    secretAccessKey,
    region,
    buckets,
    uploads,
    requests,
    faults,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startS3Server, canonicalQueryFromRaw, MIN_PART_SIZE };
