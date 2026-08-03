// Focused FTP adapter option plumbing.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { passiveClientOptions } = require('../design/main/protocols/ftp');

test('passive host policy forces the control host only when explicitly on', () => {
  assert.deepEqual(passiveClientOptions('on'), { allowSeparateTransferHost: false });
  assert.deepEqual(passiveClientOptions(true), { allowSeparateTransferHost: false });
  // Auto retains basic-ftp's NAT-aware replacement of private PASV addresses.
  assert.deepEqual(passiveClientOptions('auto'), { allowSeparateTransferHost: true });
  assert.deepEqual(passiveClientOptions('off'), { allowSeparateTransferHost: true });
  // Session-data imports may still expose the historical enum integer.
  assert.deepEqual(passiveClientOptions(0), { allowSeparateTransferHost: false });
  assert.deepEqual(passiveClientOptions(1), { allowSeparateTransferHost: true });
  assert.deepEqual(passiveClientOptions(2), { allowSeparateTransferHost: true });
});
