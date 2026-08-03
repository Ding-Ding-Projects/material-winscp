'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../design/main/exceptions');

test('the six operational categories have bounded, explicit decisions', () => {
  const expected = {
    protocol: ['retry', 'skip', 'abort'],
    validation: ['abort'],
    cancellation: ['abort'],
    authentication: ['retry', 'abort'],
    permission: ['skip', 'abort'],
    transport: ['retry', 'skip', 'abort'],
  };
  for (const [category, decisions] of Object.entries(expected)) {
    const error = E.createError(category, 'failure', { operation: 'upload' });
    assert.equal(error.category, category);
    assert.deepEqual(error.toFacts().decisions, decisions);
    assert.equal(E.canChoose(error, decisions[0]), true);
    assert.equal(E.canChoose(error, 'nope'), false);
  }
});

test('native protocol, validation, cancellation, auth, permission and transport errors classify safely', () => {
  const cases = [
    [{ name: 'ProtocolError', code: 'EPROTO', message: 'bad packet' }, 'protocol'],
    [{ name: 'ValidationError', message: 'path is required' }, 'validation'],
    [{ name: 'AbortError', code: 'ABORT_ERR', message: 'aborted' }, 'cancellation'],
    [{ statusCode: 401, message: 'login failed' }, 'authentication'],
    [{ code: 'EACCES', message: 'permission denied' }, 'permission'],
    [{ code: 'ETIMEDOUT', message: 'connection timed out' }, 'transport'],
  ];
  for (const [source, category] of cases) {
    const error = E.classifyError(source, { operation: 'download' });
    assert.equal(error.category, category, JSON.stringify(source));
    assert.equal(error.operation, 'download');
    assert.equal(error.toFacts().hasCause, true);
  }
});

test('a cause remains available to diagnostics but never crosses the facts boundary', () => {
  const cause = new Error('server password=correct horse battery staple');
  const error = E.classifyError(cause, {
    category: 'authentication',
    secrets: ['correct horse battery staple'],
    details: {
      host: 'example.test',
      password: 'correct horse battery staple',
      response: { body: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----' },
    },
  });
  assert.equal(error.cause, cause);
  assert.match(error.message, /\[redacted\]/);
  assert.doesNotMatch(error.message, /correct horse battery staple/);
  const encoded = JSON.stringify(error);
  assert.doesNotMatch(encoded, /correct horse battery staple|private key/i);
  assert.deepEqual(error.toFacts().details, {
    host: 'example.test',
    response: { body: '[redacted]' },
  });
});

test('PEM blocks, URL credentials and secret assignments are redacted', () => {
  const privateKey = '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----';
  const text = E.redactText(
    `sftp://user:pw@example.test password=pw passphrase: pw ${privateKey}`,
    ['pw'],
  );
  assert.doesNotMatch(text, /pw|BEGIN PRIVATE KEY|abc123/);
  assert.doesNotMatch(text, /password|passphrase|private key/i);
  assert.match(text, /sftp:\/\/user:\[redacted\]@example\.test/);
  const details = E.sanitizeDetails({ privateKey, nested: { token: 't', path: '/safe' } }, ['t']);
  assert.deepEqual(details, { nested: { path: '/safe' } });
});

test('unknown errors use a truthful generic fallback and retain no internal message', () => {
  const error = E.classifyError(new Error('ENOENT /secret/private-key.pem token=abc'));
  assert.equal(error.category, 'unknown');
  assert.equal(error.code, 'UNEXPECTED_ERROR');
  assert.equal(error.message, 'The operation failed unexpectedly.');
  assert.deepEqual(error.toFacts().decisions, ['retry', 'abort']);
  assert.doesNotMatch(JSON.stringify(E.serializeError(error)), /private-key|token=abc|ENOENT/);
});

test('facts are JSON-safe and caller context can refine category and retry policy', () => {
  const facts = E.serializeError(new Error('temporary issue'), {
    category: 'transport',
    code: 'EHOSTUNREACH',
    protocol: 'sftp',
    operation: 'list',
    retryable: true,
    details: { status: 503, attempt: 2 },
  });
  assert.deepEqual(facts, {
    category: 'transport',
    code: 'EHOSTUNREACH',
    message: 'temporary issue',
    retryable: true,
    decisions: ['retry', 'skip', 'abort'],
    hasCause: true,
    operation: 'list',
    protocol: 'sftp',
    details: { status: 503, attempt: 2 },
  });
  assert.doesNotThrow(() => JSON.stringify(facts));
});

test('invalid decision overrides fall back to the category contract', () => {
  const error = E.createError('validation', 'bad value', { decisions: ['retry', 'nonsense'] });
  assert.deepEqual(error.decisions, ['abort']);
  assert.equal(E.classifyCategory(null), 'unknown');
});
