'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { S3Adapter } = require('../design/main/protocols/s3');

const SESSION = {
  hostName: 's3.example.test',
  portNumber: 443,
  ftps: 'tls',
  userName: 'base-access-key',
  s3RoleArn: 'arn:aws:iam::123456789012:role/ReadOnly',
  s3DefaultRegion: 'us-east-1',
};

function response(xml) {
  return { status: 200, body: Buffer.from(xml, 'utf8') };
}

function adapterWith(xml) {
  const adapter = new S3Adapter(SESSION, { password: 'base-secret' });
  adapter._httpSigned = async (request) => {
    assert.equal(request.service, 'sts');
    assert.equal(request.method, 'POST');
    return response(xml);
  };
  adapter.region = 'us-east-1';
  adapter.credentials = {
    accessKeyId: 'base-access-key',
    secretAccessKey: 'base-secret',
    sessionToken: '',
    expiresAt: 0,
  };
  return adapter;
}

test('AssumeRole installs all returned temporary credential fields', async () => {
  const adapter = adapterWith(`
    <AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
      <AssumeRoleResult><Credentials>
        <AccessKeyId>temporary-key</AccessKeyId>
        <SecretAccessKey>temporary-secret</SecretAccessKey>
        <SessionToken>temporary-token</SessionToken>
        <Expiration>2030-01-01T00:00:00Z</Expiration>
      </Credentials></AssumeRoleResult>
    </AssumeRoleResponse>`);

  await adapter._assumeRole();
  assert.equal(adapter.credentials.accessKeyId, 'temporary-key');
  assert.equal(adapter.credentials.secretAccessKey, 'temporary-secret');
  assert.equal(adapter.credentials.sessionToken, 'temporary-token');
  assert.equal(adapter.credentials.expiresAt, Date.parse('2030-01-01T00:00:00Z'));
});

test('AssumeRole rejects incomplete temporary credentials before use', async () => {
  const adapter = adapterWith(`
    <AssumeRoleResponse><AssumeRoleResult><Credentials>
      <AccessKeyId>temporary-key</AccessKeyId>
      <SecretAccessKey></SecretAccessKey>
      <SessionToken>temporary-token</SessionToken>
      <Expiration>2030-01-01T00:00:00Z</Expiration>
    </Credentials></AssumeRoleResult></AssumeRoleResponse>`);

  await assert.rejects(
    () => adapter._assumeRole(),
    /AssumeRole returned incomplete credentials: missing SecretAccessKey/,
  );
  assert.equal(adapter.credentials.secretAccessKey, 'base-secret');
});
