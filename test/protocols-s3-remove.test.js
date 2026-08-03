'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { S3Adapter, S3UploadStream } = require('../design/main/protocols/s3');

const FIVE_MIB = 5 * 1024 * 1024;

function adapterWithDirectory(markerError) {
  const adapter = new S3Adapter({ hostName: 's3.example.test', portNumber: 443, ftps: 'tls' });
  const calls = [];
  adapter.stat = async () => ({ type: 'dir' });
  adapter._deletePrefix = async () => {};
  adapter._s3 = async (method, bucket, key) => {
    calls.push({ method, bucket, key });
    if (markerError) throw markerError;
  };
  return { adapter, calls };
}

test('removing a folder tolerates a marker deleted by a concurrent actor', async () => {
  const { adapter, calls } = adapterWithDirectory({ status: 404 });

  await adapter.remove('/bucket/folder');

  assert.deepEqual(calls, [{ method: 'DELETE', bucket: 'bucket', key: 'folder/' }]);
});

test('removing a folder still reports non-not-found marker failures', async () => {
  const failure = Object.assign(new Error('access denied'), { status: 403 });
  const { adapter } = adapterWithDirectory(failure);

  await assert.rejects(() => adapter.remove('/bucket/folder'), failure);
});

test('a multipart completion failure aborts the remote upload only once', async () => {
  let aborted = 0;
  const adapter = {
    _createMultipartUpload: async () => 'failed-completion-upload',
    _uploadPart: async () => 'etag',
    _abortMultipartUpload: async () => { aborted += 1; },
    _putObject: async () => ({ etag: 'etag' }),
    _completeMultipartUpload: async () => { throw new Error('completion failed'); },
  };
  const stream = new S3UploadStream(adapter, 'bucket', 'failed.bin', { size: FIVE_MIB });
  const failed = new Promise((resolve) => stream.once('error', resolve));
  stream.end(Buffer.alloc(FIVE_MIB));

  const error = await failed;
  assert.match(error.message, /completion failed/);
  assert.equal(aborted, 1, 'completion failure cleans up one multipart upload');
});
