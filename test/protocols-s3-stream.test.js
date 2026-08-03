'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { S3Adapter, S3UploadStream, hostHeader } = require('../design/main/protocols/s3');

test('S3 range reads reject invalid offsets before making a request', async () => {
  const adapter = new S3Adapter({ hostName: 's3.example.test', portNumber: 443, ftps: 'tls' });
  let seen;
  adapter._s3 = async (method, bucket, key, opts) => {
    seen = { method, bucket, key, headers: opts.headers };
    return { status: 206, stream: Readable.from([Buffer.from('tail')]) };
  };

  for (const start of [-1, 1.5, Infinity, NaN]) {
    await assert.rejects(
      () => adapter.createReadStream('/bucket/file.bin', { start }),
      /S3 range start must be a non-negative integer/,
    );
  }
  await assert.rejects(
    () => adapter.createReadStream('/bucket/file.bin', { start: 8, end: 7 }),
    /S3 range end must be an integer at or after the start/,
  );
  assert.equal(seen, undefined, 'invalid offsets never reach S3');
});

test('S3 range reads preserve an explicit zero end offset', async () => {
  const adapter = new S3Adapter({ hostName: 's3.example.test', portNumber: 443, ftps: 'tls' });
  let headers;
  adapter._s3 = async (method, bucket, key, opts) => {
    headers = opts.headers;
    return { status: 206, stream: Readable.from([Buffer.from('one')]) };
  };

  const stream = await adapter.createReadStream('/bucket/file.bin', { start: 0, end: 0 });
  assert.deepEqual(headers, { range: 'bytes=0-0' });
  assert.deepEqual(await (async () => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  })(), 'one');
});

test('destroying an active multipart stream without an error still aborts it', async () => {
  let aborted = 0;
  const stream = new S3UploadStream({
    _abortMultipartUpload: async () => { aborted += 1; },
  }, 'bucket', 'file.bin');
  stream.uploadId = 'upload-to-cancel';
  const closed = new Promise((resolve) => stream.once('close', resolve));
  stream.destroy();
  await closed;
  assert.equal(aborted, 1);
});

test('S3 connect does not hide transport failures as bucket-scoped credentials', async () => {
  const adapter = new S3Adapter({
    hostName: 's3.example.test', portNumber: 80, ftps: 'none', userName: 'access-key',
  }, { password: 'secret' });
  adapter._listBuckets = async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); };

  await assert.rejects(() => adapter.connect(), /ECONNREFUSED/);
  assert.equal(adapter.connected, false);
  await adapter.disconnect();
});

test('S3 IPv6 endpoints use path addressing and a bracketed Host header', () => {
  const adapter = new S3Adapter({ hostName: '2001:db8::1', portNumber: 9000, ftps: 'none' });
  assert.deepEqual(adapter._addressing('bucket'), { host: '2001:db8::1', prefix: '/bucket' });
  assert.equal(hostHeader('2001:db8::1', 9000, false), '[2001:db8::1]:9000');
});
