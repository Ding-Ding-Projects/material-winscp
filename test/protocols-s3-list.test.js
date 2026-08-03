'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { S3Adapter } = require('../design/main/protocols/s3');

test('stops when a truncated listing repeats its continuation token', async () => {
  const adapter = new S3Adapter({ hostName: 's3.example.test', portNumber: 443, ftps: 'tls' });
  const requests = [];
  const warnings = [];
  adapter._log = (level, message) => warnings.push({ level, message });
  adapter._s3 = async (method, bucket, key, { query }) => {
    requests.push({ method, bucket, key, query });
    return {
      body: Buffer.from(`<?xml version="1.0"?><ListBucketResult>
        <Contents><Key>page-${requests.length}.txt</Key><Size>1</Size></Contents>
        <IsTruncated>true</IsTruncated><NextContinuationToken>same-token</NextContinuationToken>
      </ListBucketResult>`),
    };
  };

  const result = await adapter._listObjects('bucket', '', { delimiter: '/' });

  assert.equal(requests.length, 2, 'the repeated token is attempted once, then the loop stops');
  assert.equal(requests[1].query['continuation-token'], 'same-token');
  assert.deepEqual(result.contents.map((item) => item.key), ['page-1.txt', 'page-2.txt']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /repeated a continuation token/);
});

test('deduplicates repeated common prefixes from overlapping pages', async () => {
  const adapter = new S3Adapter({ hostName: 's3.example.test', portNumber: 443, ftps: 'tls' });
  adapter._listObjects = async () => ({
    contents: [],
    prefixes: ['folder/', 'folder/', 'other/'],
  });

  const rows = await adapter.list('/bucket');

  assert.deepEqual(rows.map((row) => row.name), ['folder', 'other']);
  assert.ok(rows.every((row) => row.type === 'dir'));
});
