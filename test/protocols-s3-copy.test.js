'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { S3Adapter, S3UploadStream } = require('../design/main/protocols/s3');

const FIVE_MIB = 5 * 1024 * 1024;
const FIVE_GIB = 5 * 1024 * 1024 * 1024;

test('multipart server-side copy partitions a >5 GiB object and completes it', async () => {
  const adapter = new S3Adapter({ hostName: 's3.example.test', portNumber: 443, ftps: 'tls' });
  const requests = [];
  let completion;

  adapter._createMultipartUpload = async () => 'copy-upload-1';
  adapter._s3 = async (method, bucket, key, options = {}) => {
    assert.equal(method, 'PUT');
    assert.equal(bucket, 'destination');
    assert.equal(key, 'large-copy.bin');
    const partNumber = Number(options.query.partNumber);
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers['x-amz-copy-source-range']);
    assert.ok(match, 'UploadPartCopy carries a byte range');
    requests.push({ partNumber, start: Number(match[1]), end: Number(match[2]) });
    return { body: Buffer.from(`<CopyPartResult><ETag>"etag-${partNumber}"</ETag></CopyPartResult>`) };
  };
  adapter._completeMultipartUpload = async (bucket, key, uploadId, parts) => {
    completion = { bucket, key, uploadId, parts };
  };

  const size = FIVE_GIB + 1;
  await adapter._copyObject('source', 'large-source.bin', 'destination', 'large-copy.bin', size);

  assert.equal(requests.length, Math.ceil(size / FIVE_MIB));
  assert.equal(requests[0].partNumber, 1);
  assert.equal(requests[0].start, 0);
  assert.ok(requests[0].end - requests[0].start + 1 >= FIVE_MIB);
  for (let i = 1; i < requests.length; i += 1) {
    assert.equal(requests[i].partNumber, i + 1);
    assert.equal(requests[i].start, requests[i - 1].end + 1);
    assert.ok(requests[i].end - requests[i].start + 1 >= FIVE_MIB || i === requests.length - 1);
  }
  assert.equal(requests.at(-1).end, size - 1);
  assert.deepEqual(completion, {
    bucket: 'destination',
    key: 'large-copy.bin',
    uploadId: 'copy-upload-1',
    parts: requests.map(({ partNumber }) => ({ partNumber, etag: `etag-${partNumber}` })),
  });
});

test('cancelling a multipart upload aborts the remote upload', async () => {
  const controller = new AbortController();
  let aborted = 0;
  const adapter = {
    _createMultipartUpload: async () => 'cancel-upload',
    _uploadPart: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return 'etag'; },
    _abortMultipartUpload: async () => { aborted += 1; },
    _putObject: async () => ({ etag: 'etag' }),
    _completeMultipartUpload: async () => ({ etag: 'etag' }),
  };
  const stream = new S3UploadStream(adapter, 'bucket', 'cancel.bin', { size: FIVE_MIB, signal: controller.signal });
  const failed = new Promise((resolve) => stream.once('error', resolve));
  stream.end(Buffer.alloc(FIVE_MIB));
  await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  const error = await failed;
  assert.match(error.message, /cancelled/);
  assert.equal(aborted, 1, 'cancellation aborts the in-progress multipart upload');
});
