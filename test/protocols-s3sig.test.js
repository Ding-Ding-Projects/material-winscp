// protocols-s3sig.test.js — AWS Signature Version 4, against AWS's own
// published test vectors.
//
// Signing is the one part of the S3 backend where "looks right" is worthless:
// a wrong canonical request produces `SignatureDoesNotMatch` and no hint about
// which of the six lines was wrong. So the expected canonical request, string
// to sign and signature below are the values AWS documents, and all three are
// asserted — a mismatch points straight at the stage that broke.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  S3Adapter,
  signRequestV4, createCanonicalRequest, createStringToSign, deriveSigningKey,
  canonicalQuery, canonicalHeaders, uriEncode, amzDate, sha256hex,
  parseAwsIni, parseXml, EMPTY_SHA256,
} = require('../design/main/protocols/s3');

test('S3 max-keys is normalized to an integer accepted by the service', () => {
  const adapter = new S3Adapter({ s3MaxKeys: 2.9 });
  assert.equal(adapter._maxKeys(), 2);
  adapter.session.s3MaxKeys = 0.5;
  assert.equal(adapter._maxKeys(), 1);
});

test('S3 XML reader preserves numeric entities outside Unicode instead of throwing', () => {
  assert.doesNotThrow(() => parseXml('<Error><Message>&#x110000;</Message></Error>'));
  const doc = parseXml('<Error><Message>&#x110000; &#xD800; &#x41;</Message></Error>');
  assert.equal(doc.children[0].children[0].text, '&#x110000; &#xD800; A');
});

// ---------------------------------------------------------------------------
// The signing key derivation vector from the AWS "Signature Version 4 signing
// process" documentation (secret wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY,
// 20120215, us-east-1, iam).
// ---------------------------------------------------------------------------

test('signing key derivation matches the AWS documented vector', () => {
  const key = deriveSigningKey(
    'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam',
  );
  assert.strictEqual(
    key.toString('hex'),
    'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
  );
});

// ---------------------------------------------------------------------------
// aws-sig-v4-test-suite: get-vanilla
// ---------------------------------------------------------------------------

const SUITE_CREDS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const SUITE_DATE = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));

test('get-vanilla produces the documented canonical request, string to sign and signature', () => {
  const signed = signRequestV4({
    method: 'GET',
    path: '/',
    query: null,
    headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
    service: 'service',
    region: 'us-east-1',
    date: SUITE_DATE,
    ...SUITE_CREDS,
  });

  assert.strictEqual(signed.canonicalRequest, [
    'GET',
    '/',
    '',
    'host:example.amazonaws.com',
    'x-amz-date:20150830T123600Z',
    '',
    'host;x-amz-date',
    EMPTY_SHA256,
  ].join('\n'));

  assert.strictEqual(signed.stringToSign, [
    'AWS4-HMAC-SHA256',
    '20150830T123600Z',
    '20150830/us-east-1/service/aws4_request',
    sha256hex(signed.canonicalRequest),
  ].join('\n'));

  assert.strictEqual(
    signed.signature,
    '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
  assert.strictEqual(
    signed.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, '
    + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  );
});

test('get-vanilla-query-order-key-case: query parameters sort by key then value', () => {
  const signed = signRequestV4({
    method: 'GET',
    path: '/',
    query: [['Param2', 'value2'], ['Param1', 'value1']],
    headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
    service: 'service',
    region: 'us-east-1',
    date: SUITE_DATE,
    ...SUITE_CREDS,
  });
  assert.ok(signed.canonicalRequest.includes('\nParam1=value1&Param2=value2\n'));
  assert.strictEqual(
    signed.signature,
    'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
  );
});

test('get-header-value-trim: header values are trimmed and inner runs collapsed', () => {
  const signed = signRequestV4({
    method: 'POST',
    path: '/',
    headers: {
      Host: 'example.amazonaws.com',
      'X-Amz-Date': '20150830T123600Z',
      'My-Header1': '  value1  ',
    },
    service: 'service',
    region: 'us-east-1',
    date: SUITE_DATE,
    ...SUITE_CREDS,
  });
  assert.ok(signed.canonicalRequest.includes('\nmy-header1:value1\n'));
  assert.strictEqual(signed.signedHeaders, 'host;my-header1;x-amz-date');
});

// ---------------------------------------------------------------------------
// The S3-specific examples from the AWS "Examples of the complete Version 4
// signing process" documentation. Credentials AKIAIOSFODNN7EXAMPLE /
// wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, bucket examplebucket, us-east-1,
// 20130524T000000Z.
// ---------------------------------------------------------------------------

const S3_CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const S3_DATE = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));

test('S3 GET Object with a Range header matches the documented signature', () => {
  const signed = signRequestV4({
    method: 'GET',
    path: '/test.txt',
    headers: {
      Host: 'examplebucket.s3.amazonaws.com',
      Range: 'bytes=0-9',
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': '20130524T000000Z',
    },
    payloadHash: EMPTY_SHA256,
    service: 's3',
    region: 'us-east-1',
    date: S3_DATE,
    ...S3_CREDS,
  });

  assert.strictEqual(signed.signedHeaders, 'host;range;x-amz-content-sha256;x-amz-date');
  assert.strictEqual(signed.canonicalRequest, [
    'GET',
    '/test.txt',
    '',
    'host:examplebucket.s3.amazonaws.com',
    'range:bytes=0-9',
    `x-amz-content-sha256:${EMPTY_SHA256}`,
    'x-amz-date:20130524T000000Z',
    '',
    'host;range;x-amz-content-sha256;x-amz-date',
    EMPTY_SHA256,
  ].join('\n'));
  assert.strictEqual(
    signed.signature,
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('S3 PUT Object signs the payload hash and a storage class header', () => {
  const body = Buffer.from('Welcome to Amazon S3.', 'utf8');
  const payloadHash = sha256hex(body);
  assert.strictEqual(
    payloadHash,
    '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
  );

  const signed = signRequestV4({
    method: 'PUT',
    path: '/test$file.text',
    headers: {
      Date: 'Fri, 24 May 2013 00:00:00 GMT',
      Host: 'examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': '20130524T000000Z',
      'x-amz-storage-class': 'REDUCED_REDUNDANCY',
    },
    payloadHash,
    service: 's3',
    region: 'us-east-1',
    date: S3_DATE,
    ...S3_CREDS,
  });

  // `$` is not unreserved, so the signed path is the escaped one — this is
  // exactly the case that breaks when path encoding is done wrong.
  assert.ok(signed.canonicalRequest.startsWith('PUT\n/test%24file.text\n'));
  assert.strictEqual(
    signed.signedHeaders,
    'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class',
  );
  assert.strictEqual(
    signed.signature,
    '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
  );
});

test('S3 GET Bucket (list objects) with query parameters matches the documented signature', () => {
  const signed = signRequestV4({
    method: 'GET',
    path: '/',
    query: { 'max-keys': '2', prefix: 'J' },
    headers: {
      Host: 'examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': '20130524T000000Z',
    },
    payloadHash: EMPTY_SHA256,
    service: 's3',
    region: 'us-east-1',
    date: S3_DATE,
    ...S3_CREDS,
  });

  assert.ok(signed.canonicalRequest.includes('\nmax-keys=2&prefix=J\n'));
  assert.strictEqual(
    signed.signature,
    '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
  );
});

test('S3 GET Bucket Lifecycle matches the documented signature', () => {
  const signed = signRequestV4({
    method: 'GET',
    path: '/',
    query: { lifecycle: '' },
    headers: {
      Host: 'examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': '20130524T000000Z',
    },
    payloadHash: EMPTY_SHA256,
    service: 's3',
    region: 'us-east-1',
    date: S3_DATE,
    ...S3_CREDS,
  });
  // A valueless query parameter still signs as `key=`.
  assert.ok(signed.canonicalRequest.includes('\nlifecycle=\n'));
  assert.strictEqual(
    signed.signature,
    'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
  );
});

// ---------------------------------------------------------------------------
// The encoding rules the vectors above only touch in passing
// ---------------------------------------------------------------------------

test('uriEncode follows RFC 3986, not encodeURIComponent', () => {
  // encodeURIComponent leaves these alone; AWS requires them escaped.
  assert.strictEqual(uriEncode("!'()*"), '%21%27%28%29%2A');
  assert.strictEqual(uriEncode('-_.~'), '-_.~');
  assert.strictEqual(uriEncode('a b+c'), 'a%20b%2Bc');
  assert.strictEqual(uriEncode('/a/b'), '%2Fa%2Fb');
  assert.strictEqual(uriEncode('/a/b', false), '/a/b');
  // Non-ASCII is UTF-8 bytes, each escaped.
  assert.strictEqual(uriEncode('報告'), '%E5%A0%B1%E5%91%8A');
});

test('canonicalQuery sorts, encodes and keeps empty values', () => {
  assert.strictEqual(canonicalQuery({ b: '2', a: '1' }), 'a=1&b=2');
  assert.strictEqual(canonicalQuery({ 'list-type': '2', prefix: 'a b/' }), 'list-type=2&prefix=a%20b%2F');
  assert.strictEqual(canonicalQuery({ uploads: '' }), 'uploads=');
  // Repeated keys sort by value once the keys tie.
  assert.strictEqual(canonicalQuery([['k', 'b'], ['k', 'a']]), 'k=a&k=b');
  assert.strictEqual(canonicalQuery(null), '');
  // undefined values are dropped rather than signed as empty.
  assert.strictEqual(canonicalQuery({ a: '1', b: undefined }), 'a=1');
});

test('canonicalHeaders lower-cases, sorts and collapses whitespace', () => {
  const { canonical, signed } = canonicalHeaders({
    'X-Amz-Date': '20150830T123600Z',
    Host: 'example.com',
    'Content-Type': '  application/xml   charset=utf-8 ',
  });
  assert.strictEqual(signed, 'content-type;host;x-amz-date');
  assert.strictEqual(canonical,
    'content-type:application/xml charset=utf-8\nhost:example.com\nx-amz-date:20150830T123600Z\n');
});

test('a session token is signed as x-amz-security-token', () => {
  const signed = signRequestV4({
    method: 'GET',
    path: '/',
    headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
    service: 'service',
    region: 'us-east-1',
    date: SUITE_DATE,
    sessionToken: 'FQoDYXdzEPT//TOKEN//',
    ...SUITE_CREDS,
  });
  assert.ok(signed.signedHeaders.includes('x-amz-security-token'));
  assert.ok(signed.canonicalRequest.includes('x-amz-security-token:FQoDYXdzEPT//TOKEN//'));
  assert.strictEqual(signed.headers['x-amz-security-token'], 'FQoDYXdzEPT//TOKEN//');
});

test('non-S3 services double-encode the canonical path', () => {
  const single = createCanonicalRequest({
    method: 'GET', path: '/a b', headers: { host: 'h' }, payloadHash: EMPTY_SHA256,
  });
  const double = createCanonicalRequest({
    method: 'GET', path: '/a b', headers: { host: 'h' }, payloadHash: EMPTY_SHA256, doubleEncodePath: true,
  });
  assert.ok(single.canonicalRequest.startsWith('GET\n/a%20b\n'));
  assert.ok(double.canonicalRequest.startsWith('GET\n/a%2520b\n'));
});

test('createStringToSign builds the scope from the request date', () => {
  const { stringToSign, credentialScope, amzDate: stamp } = createStringToSign({
    date: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)),
    region: 'eu-west-1',
    service: 's3',
    canonicalRequest: 'x',
  });
  assert.strictEqual(stamp, '20240102T030405Z');
  assert.strictEqual(credentialScope, '20240102/eu-west-1/s3/aws4_request');
  assert.strictEqual(stringToSign.split('\n')[0], 'AWS4-HMAC-SHA256');
  assert.strictEqual(stringToSign.split('\n')[3], sha256hex('x'));
});

test('amzDate drops the punctuation and the milliseconds', () => {
  assert.strictEqual(amzDate(new Date(Date.UTC(2013, 4, 24, 0, 0, 0, 456))), '20130524T000000Z');
});

// ---------------------------------------------------------------------------
// Supporting parsers
// ---------------------------------------------------------------------------

test('parseAwsIni reads credentials and config, comments and profile prefixes', () => {
  const ini = parseAwsIni([
    '[default]',
    'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
    'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    '',
    '; a comment',
    '[profile work]',
    'region = eu-central-1   # trailing comment',
    'aws_session_token = FQoD//token//',
  ].join('\n'));

  assert.strictEqual(ini.default.aws_access_key_id, 'AKIAIOSFODNN7EXAMPLE');
  assert.strictEqual(ini.default.aws_secret_access_key, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  // "[profile work]" in ~/.aws/config is the same profile as "[work]" in
  // ~/.aws/credentials.
  assert.strictEqual(ini.work.region, 'eu-central-1');
  assert.strictEqual(ini.work.aws_session_token, 'FQoD//token//');
  assert.strictEqual(ini.default.region, undefined);
});

test('the S3 XML reader handles a paged ListObjectsV2 result', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>examplebucket</Name>
  <Prefix>photos/</Prefix>
  <Delimiter>/</Delimiter>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
  <Contents>
    <Key>photos/</Key><Size>0</Size>
    <LastModified>2019-01-12T10:15:00.000Z</LastModified>
    <ETag>&quot;d41d8cd98f00b204e9800998ecf8427e&quot;</ETag>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>photos/holiday &amp; friends.jpg</Key><Size>1048576</Size>
    <LastModified>2020-03-03T09:22:00.000Z</LastModified>
    <ETag>&quot;9b2cf535f27731c974343645a3985328&quot;</ETag>
    <StorageClass>GLACIER_IR</StorageClass>
  </Contents>
  <CommonPrefixes><Prefix>photos/2019/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>photos/2020/</Prefix></CommonPrefixes>
</ListBucketResult>`;

  const doc = parseXml(xml);
  const result = doc.children.find((c) => c.name === 'ListBucketResult');
  assert.ok(result, 'the namespaced root element is found by its local name');

  const contents = result.children.filter((c) => c.name === 'Contents');
  assert.strictEqual(contents.length, 2);
  const keyOf = (n) => n.children.find((c) => c.name === 'Key').text;
  assert.strictEqual(keyOf(contents[0]), 'photos/');
  assert.strictEqual(keyOf(contents[1]), 'photos/holiday & friends.jpg');

  const prefixes = result.children.filter((c) => c.name === 'CommonPrefixes')
    .map((c) => c.children.find((x) => x.name === 'Prefix').text);
  assert.deepStrictEqual(prefixes, ['photos/2019/', 'photos/2020/']);

  const token = result.children.find((c) => c.name === 'NextContinuationToken').text;
  assert.strictEqual(token, '1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=');
});

test('the S3 XML reader surfaces an error document', () => {
  const xml = '<?xml version="1.0"?><Error><Code>NoSuchBucket</Code>'
    + '<Message>The specified bucket does not exist</Message>'
    + '<BucketName>nope</BucketName></Error>';
  const doc = parseXml(xml);
  const err = doc.children.find((c) => c.name === 'Error');
  assert.strictEqual(err.children.find((c) => c.name === 'Code').text, 'NoSuchBucket');
  assert.strictEqual(
    err.children.find((c) => c.name === 'Message').text,
    'The specified bucket does not exist',
  );
});
